// Probe round 5: street-parking sources for Parramatta and Homebush.
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
const UA = { 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' };
async function get(url, as = 'text', opts = {}) {
  const r = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, method: opts.method || 'GET', body: opts.body, redirect: 'follow', signal: AbortSignal.timeout(opts.timeout || 60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
  return as === 'buf' ? Buffer.from(await r.arrayBuffer()) : as === 'json' ? await r.json() : await r.text();
}
const BOX = { parra: [150.985, -33.835, 151.03, -33.79], sop: [151.045, -33.862, 151.09, -33.83], homebush: [151.06, -33.88, 151.1, -33.855] };

// 1. OpenStreetMap: parking lanes, parking meters / ticket machines, street-side parking with limits.
for (const [k, [w, s, e, n]] of Object.entries(BOX)) {
  const q = `[out:json][timeout:50];(way[highway][~"^parking:"~"."](${s},${w},${n},${e});node[amenity=vending_machine][vending~"parking"](${s},${w},${n},${e});node[amenity=parking_meter](${s},${w},${n},${e});nwr[amenity=parking][parking~"street_side|lane"](${s},${w},${n},${e}););out center tags;`;
  try { const j = await get('https://overpass-api.de/api/interpreter', 'json', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 70000 }); await writeFile(`out/osm-street-${k}.json`, JSON.stringify(j.elements.map((x) => ({ id: `${x.type}/${x.id}`, at: x.center ? [x.center.lon, x.center.lat] : [x.lon, x.lat], t: x.tags })))); say('osm', k, j.elements.length); }
  catch (e) { say('osm failed', k, e.message); }
}
// 2. Mapillary: detected parking meters and parking signs (positions only).
const MT = process.env.MAPILLARY_TOKEN;
if (MT) for (const [k, [w, s, e, n]] of Object.entries(BOX)) {
  const all = [];
  // the API limits bbox size, so tile it
  for (let x = w; x < e; x += 0.01) for (let y = s; y < n; y += 0.01) {
    const bbox = [x, y, Math.min(x + 0.01, e), Math.min(y + 0.01, n)].map((v) => v.toFixed(5)).join(',');
    for (const type of ['map_features']) {
      try { const j = await get(`https://graph.mapillary.com/${type}?access_token=${MT}&fields=id,object_value,geometry,first_seen_at,last_seen_at&bbox=${bbox}&limit=2000`, 'json'); all.push(...(j.data || [])); }
      catch (e2) { say('mapillary failed', k, bbox, e2.message.slice(0, 120)); }
    }
  }
  const counts = {};
  for (const f of all) counts[f.object_value] = (counts[f.object_value] || 0) + 1;
  const keep = all.filter((f) => /park|stopping|meter|clearway|loading|bus|taxi|permit|time/i.test(f.object_value));
  await writeFile(`out/mapillary-${k}.json`, JSON.stringify(keep));
  say('mapillary', k, all.length, 'parking-related', keep.length, JSON.stringify(Object.entries(counts).filter(([v]) => /park|stop|meter/i.test(v)).sort((a, b) => b[1] - a[1])));
} else say('no MAPILLARY_TOKEN');
// 3. NSW clearways (TfNSW, CC BY, 2018)
try { const b = await get('https://opendata.transport.nsw.gov.au/data/dataset/2c21b56b-8510-4261-8488-2b1db4f8d305/resource/d65c9a04-f7ad-4638-941d-10fba60a20f4/download/nswclearways_20181003_0.zip', 'buf'); await writeFile('out/clearways.zip', b); say('clearways', b.length); }
catch (e) { say('clearways failed', e.message); }
// 4. City of Parramatta business papers: the meeting list (default page and its year filter form).
try {
  const BP = 'https://businesspapers.parracity.nsw.gov.au/';
  const r = await fetch(BP, { headers: UA });
  const html = await r.text(); const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  await writeFile('out/bp-default.html', html);
  const hidden = Object.fromEntries([...html.matchAll(/<input[^>]+type="hidden"[^>]*>/g)].map((m) => [/name="([^"]+)"/.exec(m[0])?.[1], /value="([^"]*)"/.exec(m[0])?.[1] || '']).filter(([k2]) => k2));
  const selects = [...html.matchAll(/<select[^>]+name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)].map((m) => ({ name: m[1], options: [...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)].map((o) => [o[1], o[2].trim()]) }));
  say('bp selects', JSON.stringify(selects.map((s2) => ({ name: s2.name, options: s2.options.slice(0, 40) }))));
  const ysel = selects.find((s2) => s2.options.some((o) => /^20\d\d$/.test(o[1]) || /^20\d\d$/.test(o[0])));
  const urls = new Set([...html.matchAll(/URL=(Open\/[^"&'\s]+)/g)].map((m) => m[1]));
  if (ysel) for (const y of ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026']) {
    const opt = ysel.options.find((o) => o[1] === y || o[0] === y); if (!opt) continue;
    const body = new URLSearchParams({ ...hidden, __EVENTTARGET: ysel.name, [ysel.name]: opt[0] });
    for (const s2 of selects) if (s2.name !== ysel.name && s2.options[0]) body.set(s2.name, s2.options.find((o) => /all/i.test(o[1]))?.[0] ?? s2.options[0][0]);
    try { const t = await get(BP, 'text', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie } }); const before = urls.size; for (const m of t.matchAll(/URL=(Open\/[^"&'\s]+)/g)) urls.add(m[1]); say('bp year', y, urls.size - before); }
    catch (e) { say('bp year failed', y, e.message); }
  }
  await writeFile('out/bp-urls.txt', [...urls].sort().join('\n'));
  say('bp urls', urls.size);
} catch (e) { say('bp failed', e.message); }
// 5. SOPA map page (to find its data)
try { const h = await get('https://www.sydneyolympicpark.com.au/map/'); await writeFile('out/sopa-map.html', h); say('sopa map', h.length, [...h.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => /\.js|json|api|arcgis|map/i.test(u)).slice(0, 30).join(' ')); }
catch (e) { say('sopa map failed', e.message); }
await writeFile('out/log.txt', log.join('\n'));
