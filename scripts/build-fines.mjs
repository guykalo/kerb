// Parking fines for NSW: how much each fine costs and how hard each council's rangers enforce, from Revenue NSW
// open data (CC BY). Writes public/data/fines.json:
//   offences: { code: { desc, amounts: [low, high], n } }  current face values, from the latest penalty notice data
//   councils: [{ name, lga, n, value, km2, perKm2, rank, level, rings }]  parking fines last financial year
// The app looks a kerb's council up by its position (rings) and shows the fine for what the sign forbids.
// Run: node scripts/build-fines.mjs [local xlsx folder]
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';

const REV = 'https://www.revenue.nsw.gov.au/help-centre/resources-library/statistics/';
const LGA = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Administrative_Boundaries_Theme/FeatureServer/8/query';
const SYD_BOX = [150.5, -34.25, 151.45, -33.4];
const local = process.argv[2];
const log = (...a) => console.log(...a);

async function getBuf(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' }, signal: AbortSignal.timeout(120000) });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 20000)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const b = new Uint8Array(await r.arrayBuffer());
    if (b[0] !== 0x50 || b[1] !== 0x4b) throw new Error(`not an xlsx: ${url}`); // their 404 page comes back as HTML
    return b;
  }
  throw new Error(`rate limited: ${url}`);
}
const xmlText = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// A plain sheet -> array of rows (array of strings/numbers), using the shared strings table.
function sheetRows(zip, path = 'xl/worksheets/sheet1.xml') {
  const ss = zip['xl/sharedStrings.xml'] ? [...strFromU8(zip['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))) : [];
  const xml = strFromU8(zip[path]);
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = [...cm[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = /t="(\w+)"/.exec(cm[2])?.[1], v = /<v>([\s\S]*?)<\/v>/.exec(cm[3] || '')?.[1];
      const is = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cm[3] || '')?.[1];
      row[col] = t === 's' ? ss[+v] : t === 'inlineStr' ? xmlText(is || '') : v == null ? null : isNaN(+v) ? xmlText(v) : +v;
    }
    rows.push(row);
  }
  return rows;
}

// 1. Fine amounts: the newest penalty notice data file that exists (one per financial year).
async function offences() {
  const fy = (y) => `${y}-${y + 1}`;
  const now = new Date(), start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  for (const y of [start, start - 1, start - 2]) {
    try {
      const buf = local ? new Uint8Array(await readFile(`${local}/pn-${fy(y)}.xlsx`)) : await getBuf(`${REV}penalty-notice-data-${fy(y)}-dfosf-001-${y}.xlsx`);
      const rows = sheetRows(unzipSync(buf));
      const head = rows[0], ix = (n) => head.indexOf(n);
      const [cCode, cDesc, cVal, cPark, cN, cMonth] = ['OFFENCE_CODE', 'OFFENCE_DESC', 'FACE_VALUE', 'PARKING_IND', 'TOTAL_NUMBER', 'OFFENCE_MONTH'].map(ix);
      const out = {};
      let latest = 0;
      for (const r of rows.slice(1)) {
        if (r[cPark] !== 'Y') continue;
        const o = (out[r[cCode]] ||= { desc: r[cDesc], amounts: [Infinity, 0], n: 0 });
        o.amounts[0] = Math.min(o.amounts[0], r[cVal]); o.amounts[1] = Math.max(o.amounts[1], r[cVal]); o.n += r[cN] || 0;
        latest = Math.max(latest, +r[cMonth] || 0);
      }
      log(`fines: ${Object.keys(out).length} parking offences from ${fy(y)}`);
      return { year: fy(y), offences: out };
    } catch (e) { log(`fines: ${fy(y)} not available (${e.message})`); }
  }
  throw new Error('no penalty notice data');
}

// 2. Parking fines per issuing agency (council) per financial year: the pivot cache inside the report holds the rows.
async function byCouncil() {
  const buf = local ? new Uint8Array(await readFile(`${local}/dsf011.xlsx`)) : await getBuf(`${REV}parking-offences-dsf011.xlsx`);
  const zip = unzipSync(buf);
  const def = strFromU8(zip['xl/pivotCache/pivotCacheDefinition1.xml']), recs = strFromU8(zip['xl/pivotCache/pivotCacheRecords1.xml']);
  const fields = [...def.matchAll(/<cacheField name="([^"]+)"([\s\S]*?)<\/cacheField>/g)].map((m) => {
    const si = /<sharedItems[^>]*>([\s\S]*?)<\/sharedItems>/.exec(m[2]);
    return { name: m[1], items: si ? [...si[1].matchAll(/<(s|m|n|d)(?: v="([^"]*)")?\/>/g)].map((x) => xmlText(x[2] ?? '')) : [] };
  });
  const rows = [];
  for (const rm of recs.matchAll(/<r>([\s\S]*?)<\/r>/g)) {
    const row = {};
    [...rm[1].matchAll(/<(n|x|s|m)(?: v="([^"]*)")?\/>/g)].forEach((c, i) => { const f = fields[i]; if (f) row[f.name] = c[1] === 'n' ? +c[2] : c[1] === 'x' ? f.items[+c[2]] : xmlText(c[2] ?? ''); });
    rows.push(row);
  }
  const years = [...new Set(rows.map((r) => r.OFFENCE_FINYEAR))].sort();
  // The last complete financial year (the newest one is usually only a few months in).
  const months = (y) => new Set(rows.filter((r) => r.OFFENCE_FINYEAR === y).map((r) => r.OFFENCE_MONTH)).size;
  const year = [...years].reverse().find((y) => months(y) >= 12) || years[years.length - 1];
  const tot = new Map();
  for (const r of rows) if (r.OFFENCE_FINYEAR === year) { const t = tot.get(r.ISSUING_AGENCY) || tot.set(r.ISSUING_AGENCY, { n: 0, value: 0 }).get(r.ISSUING_AGENCY); t.n += r.TOTAL_NUMBER || 0; t.value += r.TOTAL_VALUE || 0; }
  log(`fines: ${tot.size} issuing agencies in ${year}`);
  return { year, tot };
}

// 3. Council areas in Sydney, with their area, to put fines per square kilometre side by side.
async function councils() {
  const env = JSON.stringify({ xmin: SYD_BOX[0], ymin: SYD_BOX[1], xmax: SYD_BOX[2], ymax: SYD_BOX[3], spatialReference: { wkid: 4326 } });
  const q = new URLSearchParams({ where: '1=1', geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'lganame', outSR: '4326', f: 'json', returnGeometry: 'true', maxAllowableOffset: '0.0008', geometryPrecision: '4' });
  const j = await (await fetch(`${LGA}?${q}`, { signal: AbortSignal.timeout(120000) })).json();
  const R = 6371.0088, rad = Math.PI / 180;
  const area = (ring) => { let s = 0; for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) s += (ring[i][0] - ring[k][0]) * rad * (2 + Math.sin(ring[k][1] * rad) + Math.sin(ring[i][1] * rad)); return Math.abs((s * R * R) / 2); };
  return (j.features || []).filter((f) => f.geometry?.rings).map((f) => ({ lga: f.attributes.lganame, rings: f.geometry.rings, km2: f.geometry.rings.reduce((a, r) => a + area(r), 0) }));
}
const norm = (s) => String(s).toUpperCase().replace(/\bTHE COUNCIL OF THE\b|\bCOUNCIL\b|\bCITY OF\b|\bMUNICIPAL\b|\bSHIRE\b|\bCITY\b|\bTHE\b|\bOF\b|[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();

const { year: fineYear, offences: off } = await offences();
const { year: cYear, tot } = await byCouncil();
const areas = await councils();
const list = [];
for (const a of areas) {
  const key = norm(a.lga);
  const hit = [...tot.entries()].find(([name]) => norm(name) === key);
  if (!hit) continue;
  list.push({ name: hit[0].replace(/^The Council of the City of Sydney$/, 'City of Sydney'), lga: a.lga, n: Math.round(hit[1].n), value: Math.round(hit[1].value), km2: +a.km2.toFixed(1), perKm2: Math.round(hit[1].n / a.km2), rings: a.rings });
}
list.sort((a, b) => b.perKm2 - a.perKm2);
list.forEach((c, i) => { c.rank = i + 1; c.level = i < list.length * 0.2 ? 'very high' : i < list.length * 0.45 ? 'high' : i < list.length * 0.75 ? 'medium' : 'low'; });
const out = { builtAt: new Date().toISOString(), fineYear, councilYear: cYear, of: list.length, source: 'Revenue NSW penalty notice data and parking offences by issuing agency (data.nsw.gov.au, CC BY); NSW council boundaries (NSW Spatial Services)', offences: off, councils: list };
await mkdir('public/data', { recursive: true });
await writeFile('public/data/fines.json', JSON.stringify(out));
log(`fines: ${list.length} Sydney councils, top ${list.slice(0, 5).map((c) => `${c.name} ${c.perKm2}/km²`).join(', ')}; ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
