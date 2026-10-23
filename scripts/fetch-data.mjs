// Downloads the open parking data Kerb is built on and saves it to data/raw/.
// Run: node scripts/fetch-data.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { fetchAll } from './lib/sources.mjs';

await mkdir('data/raw', { recursive: true });
console.log('Downloading open data…');
const raw = await fetchAll();
for (const [name, v] of Object.entries(raw)) await writeFile(`data/raw/${name}.json`, JSON.stringify(v, null, name === 'meta' ? 2 : 0));
console.log('Done.');
