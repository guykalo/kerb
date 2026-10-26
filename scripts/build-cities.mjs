// Builds Kerb's data for the other cities (Melbourne, Brisbane, Perth) into public/data/<id>/.
// Each city is fetched and built on its own: if a council server is down, that city keeps last night's download
// (data/raw-cities/<id>.json, restored from the Actions cache) and the others still update.
// Run: node scripts/build-cities.mjs [mel bne per]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fetchMelbourne, buildMelbourne } from './lib/cities/melbourne.mjs';
import { fetchBrisbane, buildBrisbane } from './lib/cities/brisbane.mjs';
import { fetchPerth, buildPerth } from './lib/cities/perth.mjs';

const CITIES = {
  mel: { name: 'Melbourne', fetch: fetchMelbourne, build: buildMelbourne },
  bne: { name: 'Brisbane', fetch: fetchBrisbane, build: buildBrisbane },
  per: { name: 'Perth', fetch: fetchPerth, build: buildPerth },
};
const only = process.argv.slice(2);
let failed = 0;
await mkdir('data/raw-cities', { recursive: true });
for (const [id, c] of Object.entries(CITIES)) {
  if (only.length && !only.includes(id)) continue;
  console.log(`${c.name}:`);
  let raw, stale = false;
  try {
    raw = await c.fetch();
    await writeFile(`data/raw-cities/${id}.json`, JSON.stringify(raw));
  } catch (e) {
    console.log(`  download failed (${e.message.split('\n')[0]}), using the last good copy`);
    try { raw = JSON.parse(await readFile(`data/raw-cities/${id}.json`, 'utf8')); stale = true; } catch { console.log('  no saved copy: keeping the published data'); failed++; continue; }
  }
  try {
    const rules = [], idx = new Map();
    const reg = { add(set) { const k = JSON.stringify(set); if (!idx.has(k)) { idx.set(k, rules.length); rules.push(set); } return idx.get(k); } };
    const out = c.build(raw, reg);
    out.features.forEach((f, i) => { f.properties.id = i + 1; });
    const dir = `public/data/${id}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/kerbs.json`, JSON.stringify({ type: 'FeatureCollection', features: out.features }));
    await writeFile(`${dir}/rules.json`, JSON.stringify(rules));
    await writeFile(`${dir}/meters.json`, '[]');
    await writeFile(`${dir}/carparks.json`, JSON.stringify(out.carparks || []));
    if (out.bays) await writeFile(`${dir}/bays.json`, JSON.stringify(out.bays));
    const meta = { city: id, builtAt: new Date().toISOString(), fetchedAt: raw.fetchedAt, stale, kerbs: out.features.length, ruleSets: rules.length, carParks: (out.carparks || []).length, bays: out.bays?.length || 0, meters: 0, permitPatterns: {} };
    await writeFile(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
    console.log(`  ${JSON.stringify(meta)}`);
  } catch (e) { console.log(`  build failed: ${e.stack}`); failed++; }
}
if (failed) process.exitCode = 1;
