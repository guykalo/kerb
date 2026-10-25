// One-off data probe (round 3): car park locations from OpenStreetMap (Nominatim + Overpass, ODbL) and a look at parkmeforfree.com.au's public page code.
import { writeFile, mkdir } from 'node:fs/promises';
const OUT = 'out';
await mkdir(OUT, { recursive: true });
const UA = { 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' };
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
async function get(url, as = 'text', opts = {}) {
  const r = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, method: opts.method || 'GET', body: opts.body, redirect: 'follow', signal: AbortSignal.timeout(opts.timeout || 45000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
  return as === 'buf' ? Buffer.from(await r.arrayBuffer()) : as === 'json' ? await r.json() : await r.text();
}
const Q = [
  'Parramatta Square car park, Parramatta', 'Erby Place, Parramatta', 'Wentworth Street car park, Parramatta', 'Justice Precinct car park, Hunter Street, Parramatta',
  'Parramatta Aquatic Centre, Parramatta', '431A Church Street, Parramatta', 'Robin Thomas Reserve, Parramatta', '38 Marion Street, Harris Park', 'Jubilee Lane, Parramatta',
  'CommBank Stadium, Parramatta', 'P1 car park, Sydney Olympic Park', 'P3 car park, Sydney Olympic Park', 'P5 car park, Sydney Olympic Park', 'P6 car park, Sydney Olympic Park',
  'P8 car park, Sydney Olympic Park', 'P2 car park, Sydney Olympic Park', 'P4 car park, Sydney Olympic Park', 'P7 car park, Sydney Olympic Park', 'Bicentennial Park, Sydney Olympic Park',
  'Blaxland Riverside Park, Sydney Olympic Park', 'Brickpit Ring Walk, Sydney Olympic Park', 'Wentworth Common, Wentworth Point', 'Sydney Olympic Park Archery Centre',
  'Herb Elliott Avenue, Sydney Olympic Park', 'Dawn Fraser Avenue, Sydney Olympic Park', 'Showground Road, Sydney Olympic Park', 'Burlington Road, Homebush', 'Exeter Road, Homebush West',
];
const geo = {};
for (const q of Q) {
  try { geo[q] = (await get(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&countrycodes=au&q=${encodeURIComponent(q)}`, 'json')).map((r) => ({ n: r.display_name, cat: `${r.category}/${r.type}`, at: [+(+r.lon).toFixed(6), +(+r.lat).toFixed(6)] })); say('geo', q, geo[q].length); }
  catch (e) { say('geo failed', q, e.message); }
  await sleep(1200);
}
await writeFile(`${OUT}/geo.json`, JSON.stringify(geo, null, 1));
const BOXES = { parra: [-33.835, 150.985, -33.79, 151.03], sop: [-33.862, 151.045, -33.83, 151.09], homebush: [-33.88, 151.06, -33.855, 151.1] };
for (const [k, [s, w, n, e]] of Object.entries(BOXES)) {
  const q = `[out:json][timeout:40];nwr[amenity=parking](${s},${w},${n},${e});out center tags;`;
  try { const j = await get('https://overpass-api.de/api/interpreter', 'json', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 60000 }); await writeFile(`${OUT}/osm-${k}.json`, JSON.stringify(j.elements.map((x) => ({ id: `${x.type}/${x.id}`, at: x.center ? [x.center.lon, x.center.lat] : [x.lon, x.lat], t: x.tags })))); say('osm', k, j.elements.length); }
  catch (e) { say('osm failed', k, e.message); }
}
// parkmeforfree.com.au: the public page and the scripts it loads (to see what features and data it has).
try {
  const html = await get('https://parkmeforfree.com.au/');
  await writeFile(`${OUT}/pmff-index.html`, html);
  const srcs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|json|webmanifest)[^"]*)"/g)].map((m) => new URL(m[1], 'https://parkmeforfree.com.au/').href);
  say('pmff scripts', srcs.join(' '));
  let i = 0;
  for (const s of srcs.slice(0, 20)) { try { const t = await get(s); await writeFile(`${OUT}/pmff-${i++}-${s.split('/').pop().split('?')[0].slice(0, 60)}`, t); say('pmff ok', s, t.length); } catch (e) { say('pmff failed', s, e.message); } }
  for (const p of ['robots.txt', 'sitemap.xml', 'about', 'faq', 'privacy', 'terms']) { try { await writeFile(`${OUT}/pmff-page-${p.replace(/\W/g, '_')}`, await get(`https://parkmeforfree.com.au/${p}`)); say('pmff page ok', p); } catch (e) { say('pmff page failed', p, e.message); } }
} catch (e) { say('pmff failed', e.message); }
await writeFile(`${OUT}/log.txt`, log.join('\n'));
