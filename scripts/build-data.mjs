// Turns the raw open data into the compact files the app loads (public/data/).
// Run: node scripts/build-data.mjs [rawDir] [outDir]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { buildData } from './lib/build.mjs';

const RAW = process.argv[2] || 'data/raw';
const OUT = process.argv[3] || 'public/data';
const load = async (n) => JSON.parse(await readFile(`${RAW}/${n}.json`, 'utf8'));
const names = ['meters', 'metersQuarterFree', 'tariffs', 'permits', 'free15', 'councilCarParks', 'streets', 'meta'];
const raw = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await load(n)])));
for (const n of ['waverley', 'woollahra', 'parkride', 'manly', 'willoughby', 'randwick']) { try { raw[n] = await load(n); } catch { /* not downloaded */ } }
raw.extraCarParks = JSON.parse(await readFile('data/carparks.json', 'utf8').catch(() => '[]'));

const out = buildData(raw);
await mkdir(OUT, { recursive: true });
for (const k of ['kerbs', 'rules', 'meters', 'carparks']) await writeFile(`${OUT}/${k}.json`, JSON.stringify(out[k]));
await writeFile(`${OUT}/meta.json`, JSON.stringify(out.meta, null, 2));
console.log(JSON.stringify({ ...out.meta, sources: undefined }, null, 2));
if (out.meta.unparsed.length) console.warn('Sign text the parser could not read:', out.meta.unparsed.map((u) => u[0]));
