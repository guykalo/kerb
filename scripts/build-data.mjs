// Turns the raw open data into the compact files the app loads (public/data/).
// Run: node scripts/build-data.mjs [rawDir] [outDir]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { simplify } from './lib/cities/common.mjs'; // drop points within 1 m of a straight line
import { buildData } from './lib/build.mjs';

const RAW = process.argv[2] || 'data/raw';
const OUT = process.argv[3] || 'public/data';
const load = async (n) => JSON.parse(await readFile(`${RAW}/${n}.json`, 'utf8'));
const names = ['meters', 'metersQuarterFree', 'tariffs', 'permits', 'free15', 'councilCarParks', 'streets', 'meta'];
const raw = Object.fromEntries((await Promise.all(names.map(async (n) => [n, await load(n).catch(() => undefined)]))).filter(([, v]) => v !== undefined));
// City of Sydney server down: carry its kerbs over from the live site (the workflow saves them to data/published/).
if (!raw.meters) {
  const pub = async (n) => JSON.parse(await readFile(`data/published/${n}.json`, 'utf8'));
  try { raw.published = { kerbs: await pub('kerbs'), rules: await pub('rules'), meters: await pub('meters'), carparks: await pub('carparks') }; console.log('City of Sydney meters unavailable: reusing the live City of Sydney kerbs.'); }
  catch { throw new Error('City of Sydney meters missing and no published copy to fall back on'); }
}
for (const n of ['waverley', 'woollahra', 'parkride', 'manly', 'willoughby', 'randwick', 'offstreet', 'manual', 'bayside', 'osm', 'clearways', 'likelyfree']) { try { raw[n] = await load(n); } catch { /* not downloaded */ } }
raw.extraCarParks = JSON.parse(await readFile('data/carparks.json', 'utf8').catch(() => '[]'));

const out = buildData(raw);
await mkdir(OUT, { recursive: true });
// Leave out empty and default properties ('' / 0 / false; z unless it's 1 or 3): the app treats missing the same,
// and it takes megabytes off the file phones download.
const slim = (fc) => ({ ...fc, features: fc.features.map((f) => { const p = {}; const g = f.geometry?.type === 'LineString' ? { type: 'LineString', coordinates: simplify(f.geometry.coordinates, 1) } : f.geometry; for (const [k, v] of Object.entries(f.properties)) if (k === 'k' || k === 'id' || k === 's' || (k === 'z' ? v === 1 || v === 3 : v !== '' && v !== 0 && v !== false && v != null)) p[k] = v; return { type: 'Feature', properties: p, geometry: g }; }) });
for (const k of ['kerbs', 'rules', 'meters', 'carparks']) await writeFile(`${OUT}/${k}.json`, JSON.stringify(k === 'kerbs' ? slim(out[k]) : out[k]));
await writeFile(`${OUT}/meta.json`, JSON.stringify(out.meta, null, 2));
console.log(JSON.stringify({ ...out.meta, sources: undefined }, null, 2));
if (out.meta.unparsed.length) console.warn('Sign text the parser could not read:', out.meta.unparsed.map((u) => u[0]));
