// One-off data probe for Parramatta / Homebush (runs on GitHub Actions; outputs pushed to the probe-out branch).
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const OUT = 'out';
await mkdir(OUT, { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0 (Kerb parking map; github.com/guykalo/kerb)' };
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
async function get(url, as = 'text', tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return as === 'buf' ? Buffer.from(await r.arrayBuffer()) : as === 'json' ? await r.json() : await r.text();
    } catch (e) { if (i >= tries) throw e; await new Promise((s) => setTimeout(s, 3000 * i)); }
  }
}
const pdfText = (file) => { try { execFileSync('pdftotext', ['-layout', file, file.replace(/\.pdf$/i, '.txt')]); return true; } catch (e) { say('pdftotext failed', file, e.message); return false; } };

// A. Documents
const DOCS = {
  'parra-fees-2026-27.pdf': 'https://www.cityofparramatta.nsw.gov.au/files/assets/public/v/2/council/fees-and-charges/2026-2027-fees-charges.pdf',
  'parra-parking-map-2021-10.pdf': 'https://www.cityofparramatta.nsw.gov.au/sites/council/files/2021-10/Parking%20Map%20for%20website%20Oct.pdf',
  'parra-cbd-meters-2013.pdf': 'https://www.cityofparramatta.nsw.gov.au/sites/council/files/2017-01/Parramatta_CBD_Parking_Meters-30_05_13.pdf',
  'parra-alt-cbd-parking-2021.pdf': 'https://www.cityofparramatta.nsw.gov.au/sites/council/files/2021-05/Parking%20Map%20alternate%20CBD%20parking.pdf',
  'sopa-fees-2025-26.pdf': 'https://www.sydneyolympicpark.nsw.gov.au/sites/default/files/2025-07/SOPA%20Fees%20%26%20Charges%202025-26_1.pdf',
  'sopa-overflow-map.pdf': 'https://www.sport.nsw.gov.au/sites/default/files/2026-05/parking_map_-_overflow_options.pdf',
  'strath-rps1.png': 'https://www.strathfield.nsw.gov.au/files/assets/public/v/1/live/roads-footpaths-and-traffic/resident-parking-scheme-1-1.png',
  'strath-rps10.png': 'https://www.strathfield.nsw.gov.au/files/assets/public/v/1/live/roads-footpaths-and-traffic/resident-parking-scheme-10.png',
  'strath-rps20.png': 'https://www.strathfield.nsw.gov.au/files/assets/public/v/1/live/roads-footpaths-and-traffic/resident-parking-scheme-area-20-boundary.png',
  'strath-rps30.png': 'https://www.strathfield.nsw.gov.au/files/assets/public/v/1/live/roads-footpaths-and-traffic/area-30-update.png',
  'strath-rps50.png': 'https://www.strathfield.nsw.gov.au/files/assets/public/v/1/live/roads-footpaths-and-traffic/area-50-map.png',
};
for (const [f, u] of Object.entries(DOCS)) {
  try { const b = await get(u, 'buf'); await writeFile(`${OUT}/${f}`, b); say('doc ok', f, b.length); if (f.endsWith('.pdf')) pdfText(`${OUT}/${f}`); }
  catch (e) { say('doc failed', f, e.message); }
}
// Parramatta and SOPA pages that might link more documents
for (const [f, u] of Object.entries({
  'page-parra-carparks.html': 'https://www.cityofparramatta.nsw.gov.au/community/getting-around/parking/car-parks/where-to-park-in-parramatta',
  'page-parra-onstreet.html': 'https://www.cityofparramatta.nsw.gov.au/community/getting-around/parking/on-street-parking',
  'page-parra-permitmap.html': 'https://www.cityofparramatta.nsw.gov.au/community/getting-around/parking/resident-parking-permits',
  'page-sopa-parking.html': 'https://www.sopa.nsw.gov.au/parking',
  'page-sopa-casual.html': 'https://www.sopa.nsw.gov.au/parking/casual-and-long-term-parking',
})) { try { await writeFile(`${OUT}/${f}`, await get(u)); say('page ok', f); } catch (e) { say('page failed', f, e.message); } }

// B. OpenStreetMap car parks (ODbL) in Parramatta CBD, Harris Park, Sydney Olympic Park, Homebush, Homebush West, Strathfield
const BOXES = { parra: [-33.835, 150.985, -33.79, 151.03], sop: [-33.86, 151.05, -33.83, 151.085], homebush: [-33.875, 151.06, -33.855, 151.095] };
for (const [k, [s, w, n, e]] of Object.entries(BOXES)) {
  const q = `[out:json][timeout:90];(nwr[amenity=parking](${s},${w},${n},${e}););out center tags;`;
  try { const j = await get(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, 'json'); await writeFile(`${OUT}/osm-parking-${k}.json`, JSON.stringify(j.elements)); say('osm', k, j.elements.length); }
  catch (e) { say('osm failed', k, e.message); }
}

// C. City of Parramatta business papers: every council agenda, 2017 onwards (from the site's sitemaps).
const BP = 'https://businesspapers.parracity.nsw.gov.au/';
const all = [];
for (let y = 2017; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
  const mm = String(m).padStart(2, '0');
  try { const x = await get(`${BP}Sitemap/Open/${y}/${mm}/sitemap.xml`); for (const u of x.matchAll(/URL=(Open\/[^<"&\s]+)/g)) all.push(u[1]); } catch { /* none that month */ }
}
const uniq = [...new Set(all)];
await writeFile(`${OUT}/parra-bp-urls.txt`, uniq.join('\n'));
say('parramatta business paper docs', uniq.length, 'codes', JSON.stringify(Object.entries(uniq.reduce((a, u) => { const c = /Open\/\d+\/\d+\/([A-Z0-9]+)_/.exec(u)?.[1]; a[c] = (a[c] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1])));
// Samples to learn the format
for (const p of ['Open/2023/12/OC_11122023_AGN_862_AT.htm', 'Open/2025/06/OC_23062025_AGN_1050_AT_WEB.htm']) {
  try { await writeFile(`${OUT}/sample-${p.split('/').pop()}`, await get(BP + 'RedirectToDoc.aspx?URL=' + p)); say('sample ok', p); } catch (e) { say('sample failed', p, e.message); }
}
await writeFile(`${OUT}/log.txt`, log.join('\n'));
