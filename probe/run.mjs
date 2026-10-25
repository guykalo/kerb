// One-off data probe (round 2).
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const OUT = 'out';
await mkdir(OUT, { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0 (Kerb parking map; github.com/guykalo/kerb)' };
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
async function get(url, as = 'text', opts = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, method: opts.method || 'GET', body: opts.body, redirect: 'follow', signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return as === 'buf' ? Buffer.from(await r.arrayBuffer()) : as === 'json' ? await r.json() : await r.text();
    } catch (e) { if (i >= 3) throw e; await new Promise((s) => setTimeout(s, 5000 * i)); }
  }
}
for (const [f, u] of Object.entries({
  'sopa-approach-map-2026.pdf': 'https://www.sydneyolympicpark.nsw.gov.au/sites/default/files/2026-03/parking-approach-map-2026.pdf',
  'page-sopa-distance.html': 'https://www.sydneyolympicpark.nsw.gov.au/parking/distance-venues',
  'page-sopa-p2p.html': 'https://www.sydneyolympicpark.nsw.gov.au/parking/point-point-parking',
  'page-sopa-map.html': 'https://www.sydneyolympicpark.com.au/map/',
  'page-sopa-faq.html': 'https://www.sopa.nsw.gov.au/parking-faqs',
  'page-sopa-ltterms.pdf': 'https://www.sydneyolympicpark.nsw.gov.au/sites/default/files/2026-07/long-term-parking-terms-and-conditions-july-2026.pdf',
})) {
  try { const b = await get(u, 'buf'); await writeFile(`${OUT}/${f}`, b); say('ok', f, b.length); if (f.endsWith('.pdf')) try { execFileSync('pdftotext', ['-layout', `${OUT}/${f}`]); } catch {} }
  catch (e) { say('failed', f, e.message); }
}
// OpenStreetMap (ODbL): car parks, plus the roads with parking tags.
const BOXES = { parra: [-33.835, 150.985, -33.79, 151.03], sop: [-33.862, 151.045, -33.83, 151.09], homebush: [-33.88, 151.06, -33.855, 151.1] };
for (const [k, [s, w, n, e]] of Object.entries(BOXES)) {
  const q = `[out:json][timeout:120];(nwr[amenity=parking](${s},${w},${n},${e});way[highway]["parking:both"](${s},${w},${n},${e});way[highway]["parking:left"](${s},${w},${n},${e});way[highway]["parking:right"](${s},${w},${n},${e}););out center tags;`;
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']) {
    try {
      const j = await get(ep, 'json', { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
      await writeFile(`${OUT}/osm-${k}.json`, JSON.stringify(j.elements)); say('osm', k, j.elements.length, ep); break;
    } catch (e) { say('osm failed', k, ep, e.message.slice(0, 200)); }
  }
}
await writeFile(`${OUT}/log.txt`, log.join('\n'));
