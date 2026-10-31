// Corrects drivers' shared sign readings in the Streety server's KV store, from server/snap-fixes.json.
// Each fix names a reading by its id (the "id" field in GET /snaps) and either:
//   "set":    fields to replace (rules, text, q, street, side ...)
//   "move":   { "street": "Gottenham Street" }: put it on the named street, on the side of the road where the
//             photo was taken ("at"), as a 40 m kerb. The street's line comes from OpenStreetMap (Overpass).
//   "delete": true
// Safe to run again: deleted readings are skipped, and set/move give the same result each time.
// Needs CLOUDFLARE_API_TOKEN (Workers KV Storage: Edit). CLOUDFLARE_ACCOUNT_ID is optional.
import { readFileSync } from 'node:fs';

const T = process.env.CLOUDFLARE_API_TOKEN;
if (!T) { console.log('no Cloudflare token: nothing to do'); process.exit(0); }
const cf = async (path, opts = {}, raw = false) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...opts, headers: { authorization: `Bearer ${T}`, ...(opts.headers || {}) } });
  if (raw) { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.text(); }
  const j = await r.json();
  if (!j.success) throw new Error(`${path}: ${JSON.stringify(j.errors)}`);
  return j;
};

const fixes = JSON.parse(readFileSync(new URL('./snap-fixes.json', import.meta.url), 'utf8'));
const A = process.env.CLOUDFLARE_ACCOUNT_ID || (await cf('/accounts')).result[0]?.id;
const ns = (await cf(`/accounts/${A}/storage/kv/namespaces?per_page=100`)).result.find((n) => n.title === 'streety-SNAPS');
if (!ns) { console.log('no KV store yet'); process.exit(0); }
const KV = `/accounts/${A}/storage/kv/namespaces/${ns.id}`;

// Every shared reading, by its id.
const keys = (await cf(`${KV}/keys?limit=1000`)).result.map((k) => k.name).filter((k) => !/^(report|read):/.test(k));
const byId = new Map();
for (const key of keys) {
  try { const v = JSON.parse(await cf(`${KV}/values/${encodeURIComponent(key)}`, {}, true)); if (v?.id) byId.set(v.id, { key, v }); } catch { /* not a reading */ }
}
console.log(`${byId.size} shared reading(s); ${fixes.length} fix(es) to apply`);

// The named street's centreline near a point: NSW road centrelines (Spatial Services) first, the same source
// the map's kerbs are built from, then OpenStreetMap (Overpass often doesn't answer GitHub's runners).
async function streetNear(at, name) {
  // Match the type too, so "Gottenham Street" never lands on "Gottenham Lane".
  const TYPE = { ST: 'STREET', RD: 'ROAD', LN: 'LANE', AVE: 'AVENUE', PL: 'PLACE', PDE: 'PARADE', DR: 'DRIVE', CRES: 'CRESCENT', TCE: 'TERRACE' };
  const tm = /\s+(STREET|ST|ROAD|RD|LANE|LN|AVENUE|AVE|PLACE|PL|PARADE|PDE|DRIVE|DR|CRESCENT|CRES|TERRACE|TCE|WAY)$/.exec(name.toUpperCase());
  const base = name.toUpperCase().slice(0, tm ? tm.index : undefined).replace(/'/g, "''");
  const type = tm ? TYPE[tm[1]] || tm[1] : null;
  try {
    const d = 0.0015, u = new URL('https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Transport_Theme/FeatureServer/5/query');
    Object.entries({ geometry: JSON.stringify({ xmin: at[0] - d, ymin: at[1] - d, xmax: at[0] + d, ymax: at[1] + d, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', where: `UPPER(roadnamebase)='${base}'${type ? ` AND UPPER(roadnametype)='${type}'` : ''}`, outFields: 'roadnamebase,roadnametype', returnGeometry: 'true', f: 'json' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const j = await (await fetch(u)).json();
    const lines = (j.features || []).flatMap((f) => f.geometry?.paths || []).filter((p) => p.length > 1);
    if (lines.length) return lines;
    console.log(`NSW roads: no ${name} here${j.error ? ` (${JSON.stringify(j.error)})` : ''}; trying OpenStreetMap`);
  } catch (e) { console.log(`NSW roads: ${e.message}; trying OpenStreetMap`); }
  const q = `[out:json][timeout:25];way(around:120,${at[1]},${at[0]})[highway][name=${JSON.stringify(name)}];out geom;`;
  for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(host, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        if (r.ok) { const j = await r.json(); return j.elements.filter((e) => e.geometry?.length > 1).map((e) => e.geometry.map((g) => [g.lon, g.lat])); }
      } catch { /* try again */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('Overpass did not answer');
}
// Same geometry as the app's "draw a kerb from the road" (src/snap.js): 40 m along the street, 4 m out to the
// side the photo was taken from.
function kerbAlong(lines, at) {
  const k = Math.cos((at[1] * Math.PI) / 180) * 111320, m = (a) => [(a[0] - at[0]) * k, (a[1] - at[1]) * 110540], back = (x, y) => [+(at[0] + x / k).toFixed(7), +(at[1] + y / 110540).toFixed(7)];
  let best = null;
  for (const L of lines) for (let i = 1; i < L.length; i++) {
    const [ax, ay] = m(L[i - 1]), [bx, by] = m(L[i]), dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    if (!l2) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)), px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
    if (!best || d < best.d) best = { d, px, py, ux: dx / Math.sqrt(l2), uy: dy / Math.sqrt(l2) };
  }
  if (!best || best.d > 80) return null;
  const side = Math.sign(best.ux * -best.py + best.uy * best.px) || 1, nx = -best.uy * side, ny = best.ux * side;
  const line = [-20, 0, 20].map((s) => back(best.px + best.ux * s + nx * 4, best.py + best.uy * s + ny * 4));
  const compass = Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'East side' : 'West side') : ny > 0 ? 'North side' : 'South side';
  return { line, side: compass, d: Math.round(best.d) };
}

const SITE = 'https://getstreety.com.au';
let KERBS = null, RULESETS = null;
const metres = (a, b) => Math.hypot((a[0] - b[0]) * Math.cos((b[1] * Math.PI) / 180) * 111320, (a[1] - b[1]) * 110540);
let failed = 0;
for (const f of fixes) {
  const hit = byId.get(f.id);
  if (!hit) { console.log(`${f.id}: not on the server (already removed?), skipped`); continue; }
  const url = `${KV}/values/${encodeURIComponent(hit.key)}`;
  try {
    if (f.delete) { await cf(url, { method: 'DELETE' }); console.log(`${f.id}: removed (${f.note || ''})`); continue; }
    const v = { ...hit.v, ...(f.set || {}) };
    if (f.move?.onKerb) {
      // Onto a kerb the live map already has on that street: the nearest one to where the photo was taken.
      KERBS ??= await (await fetch(`${SITE}/data/kerbs.json`)).json();
      RULESETS ??= await (await fetch(`${SITE}/data/rules.json`)).json();
      const near = KERBS.features.filter((x) => x.properties.s === f.move.street).map((x) => ({ x, d: Math.min(...x.geometry.coordinates.map((c) => metres(c, v.at))) })).sort((a, b) => a.d - b.d);
      for (const { x, d } of near.slice(0, 6)) console.log(`::notice title=${f.move.street} kerb ${x.properties.id}::${Math.round(d)} m from the photo; side ${x.properties.sd || x.properties.b || '?'}; ${x.geometry.coordinates.length} points; src ${x.properties.src}; pa ${x.properties.pa}; rules ${JSON.stringify(RULESETS[x.properties.k] ?? null).slice(0, 600)}`);
      const hit = near[0];
      if (!hit || hit.d > 80) throw new Error(`no ${f.move.street} kerb within 80 m of the photo`);
      Object.assign(v, { street: f.move.street, side: hit.x.properties.sd || hit.x.properties.b || '', line: hit.x.geometry.coordinates, ids: [hit.x.properties.id] });
      console.log(`${f.id}: put on ${f.move.street} kerb ${hit.x.properties.id} (${Math.round(hit.d)} m from the photo)`);
    } else if (f.move) {
      const k = kerbAlong(await streetNear(v.at, f.move.street), v.at);
      if (!k) throw new Error(`no ${f.move.street} within 80 m of the photo`);
      Object.assign(v, { street: f.move.street, side: k.side, line: k.line, ids: [] });
      console.log(`${f.id}: moved to ${f.move.street}, ${k.side.toLowerCase()} (${k.d} m from the photo)`);
    }
    v.fixed = { date: new Date().toISOString().slice(0, 10), note: f.note || '' };
    await cf(url, { method: 'PUT', body: JSON.stringify(v), headers: { 'content-type': 'text/plain' } });
    console.log(`${f.id}: saved: ${v.street}, ${v.text}`);
  } catch (e) { failed++; console.log(`::error title=Snap ${f.id}::${e.message}`); }
}
if (failed) process.exit(1);
