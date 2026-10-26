// Static "Parking in <suburb>" pages for search engines, built after the app from the published data:
// dist/parking/<city>/<suburb>/index.html, plus dist/parking/index.html, sitemap.xml and robots.txt.
// Every number comes from Kerb's data and says where it's from; nothing is estimated here.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SITE = (process.env.SITE_URL || 'https://guykalo.github.io/kerb/').replace(/\/?$/, '/');
const CITIES = { syd: ['Sydney', 'public/data/'], mel: ['Melbourne', 'public/data/mel/'], bne: ['Brisbane', 'public/data/bne/'], per: ['Perth', 'public/data/per/'] };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slug = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const money = (v) => `$${(Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, '')}`;
const mid = (c) => c[Math.floor(c.length / 2)];

// Cheapest published price for a 2-hour weekday stay arriving at 10am (casual, hourly and flat rates only).
function twoHours(cp) {
  let best = null;
  for (const r of cp.rates || []) {
    if (!r.days?.includes(2)) continue;
    let p = null;
    if (r.kind === 'free' && (r.from ?? 0) <= 10 && (r.to ?? 24) > 10 && (!r.maxStay || r.maxStay >= 2)) p = 0;
    if (r.kind === 'casual' && (r.from ?? 0) <= 10 && (r.to ?? 24) > 10) { const b = (r.bands || []).find((x) => x[0] >= 2 - 1e-9); if (b) p = b[1]; }
    if (r.kind === 'hourly' && (r.from ?? 0) <= 10 && (r.to ?? 24) > 10 && (!r.maxStay || r.maxStay >= 2)) p = Math.min(r.dailyMax ?? Infinity, Math.ceil(Math.max(0, 2 - (r.freeFirst || 0)) / (r.per || 1)) * r.perHour * (r.per || 1));
    if (p != null && (best == null || p < best)) best = p;
  }
  return best;
}

const pages = [];
const page = (title, desc, body, path) => `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE}${path}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website">
<link rel="icon" href="${'../'.repeat(path.split('/').length - 1)}favicon.svg">
<style>:root{--fg:#0f2230;--muted:#5b6b78;--line:#e3e8ec;--free:#0f7a43;--paid:#a86a00;--bg:#fff;--card:#f5f7f9}@media (prefers-color-scheme:dark){:root{--fg:#e8eef2;--muted:#9fb0bc;--line:#24323d;--bg:#0d151b;--card:#14202a;--free:#3ccf83;--paid:#f0b44a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:30px;line-height:1.15;margin:8px 0 4px}h2{font-size:19px;margin:28px 0 8px}.lead{color:var(--muted);margin:0 0 16px}
.cta{display:inline-block;background:#0b6bcb;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:999px;margin:8px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.stat{background:var(--card);border-radius:12px;padding:10px 12px}.stat b{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;font-size:15px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.free{color:var(--free);font-weight:700}.paid{color:var(--paid);font-weight:700}small,.note{color:var(--muted)}a{color:#0b6bcb}ul.links{columns:2;padding-left:18px}</style></head>
<body><main><a href="${'../'.repeat(path.split('/').length - 1)}">Kerb</a> · <a href="${'../'.repeat(path.split('/').length - 2)}">All areas</a>${body}
<p class="note">Kerb reads councils' open data and published fee lists. The sign on the street always wins: check it before you leave the car.</p></main></body></html>`;

let any = false;
for (const [cid, [cname, dir]] of Object.entries(CITIES)) {
  if (!existsSync(dir + 'kerbs.json')) continue;
  any = true;
  const K = JSON.parse(await readFile(dir + 'kerbs.json', 'utf8')), R = JSON.parse(await readFile(dir + 'rules.json', 'utf8'));
  const C = existsSync(dir + 'carparks.json') ? JSON.parse(await readFile(dir + 'carparks.json', 'utf8')) : [];
  const areas = new Map();
  for (const f of K.features) {
    const p = f.properties, b = (p.b || '').trim();
    if (!b || !p.s || /^unnamed|permit street/i.test(p.s)) continue;
    const a = areas.get(b) || areas.set(b, { name: b, kerbs: [], pts: [] }).get(b);
    a.kerbs.push(f); a.pts.push(mid(f.geometry.coordinates));
  }
  for (const a of areas.values()) {
    if (a.kerbs.length < 15) continue;
    const cx = a.pts.reduce((s, q) => s + q[0], 0) / a.pts.length, cy = a.pts.reduce((s, q) => s + q[1], 0) / a.pts.length;
    // Streets: what the published signs say, one row per street (the most common sign on it).
    const streets = new Map();
    let meters = 0, freeLimit = 0, likely = 0, permit = 0;
    const rates = [];
    for (const f of a.kerbs) {
      const p = f.properties, set = p.k >= 0 ? R[p.k] : null;
      if (p.lk) likely++;
      else if (p.k < 0 && p.pa) permit++;
      if (!set) continue;
      const paid = set.rules.filter((r) => r[4] > 0), lim = set.rules.filter((r) => r[4] === 0 && !r[6] && r[0] > 0 && r[0] < 24);
      if (set.rules.some((r) => r[4] !== 0)) meters++;
      if (lim.length) freeLimit++;
      paid.forEach((r) => rates.push(r[4]));
      const st = streets.get(p.s) || streets.set(p.s, { n: 0, texts: new Map(), paid: [], freeNow: 0 }).get(p.s);
      st.n++;
      if (set.text) st.texts.set(set.text, (st.texts.get(set.text) || 0) + 1);
      paid.forEach((r) => st.paid.push(r[4]));
      if (lim.length) st.freeNow++;
    }
    if (meters + freeLimit + likely + permit < 10) continue;
    const near = C.filter((cp) => Array.isArray(cp.at) && Math.hypot((cp.at[0] - cx) * 92000, (cp.at[1] - cy) * 111000) < 900)
      .map((cp) => ({ cp, p: twoHours(cp) })).sort((x, y) => (x.p ?? 1e9) - (y.p ?? 1e9)).slice(0, 8);
    const path = `parking/${cid}/${slug(a.name)}/`;
    const min = rates.length ? Math.min(...rates) : null, max = rates.length ? Math.max(...rates) : null;
    const title = `Parking in ${a.name}${a.name === cname ? '' : `, ${cname}`}: free streets, meter rates and car parks | Kerb`;
    const desc = `Where to park in ${a.name}: ${meters ? `${meters} metered stretches${min != null ? ` (${money(min)} to ${money(max)} an hour)` : ''}, ` : ''}${freeLimit ? `${freeLimit} free time-limited stretches, ` : ''}${near.length ? `${near.length} car parks nearby, ` : ''}from council open data. Check any street at any time on Kerb's live map.`;
    const rows = [...streets.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 40).map(([s, st]) => {
      const text = [...st.texts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
      const pr = st.paid.length ? `<span class="paid">${money(Math.min(...st.paid))}${Math.max(...st.paid) > Math.min(...st.paid) ? `–${money(Math.max(...st.paid))}` : ''}/hr</span>` : st.freeNow ? '<span class="free">Free (time limit)</span>' : '';
      return `<tr><td><b>${esc(s)}</b></td><td>${pr}</td><td><small>${esc(text.slice(0, 140))}</small></td></tr>`;
    }).join('');
    const cps = near.map(({ cp, p }) => `<tr><td><b>${esc(cp.name)}</b>${cp.operator ? `<br><small>${esc(cp.operator)}</small>` : ''}</td><td>${p == null ? '<small>Rates not published</small>' : p === 0 ? '<span class="free">Free</span>' : `${cp.maxRates ? 'up to ' : ''}<b>${money(p)}</b>`}</td></tr>`).join('');
    const body = `<h1>Parking in ${esc(a.name)}</h1><p class="lead">${esc(cname)}. Free streets, meter rates and car park prices from council open data, updated nightly.</p>
<a class="cta" href="${'../'.repeat(3)}?city=${cid}#at=${cy.toFixed(5)},${cx.toFixed(5)}">Open the live map of ${esc(a.name)}</a>
<div class="stats">${meters ? `<div class="stat"><b>${meters}</b>metered stretches${min != null ? `<br><small>${money(min)}–${money(max)} an hour</small>` : ''}</div>` : ''}${freeLimit ? `<div class="stat"><b>${freeLimit}</b>free stretches with a time limit</div>` : ''}${permit ? `<div class="stat"><b>${permit}</b>resident permit stretches</div>` : ''}${likely ? `<div class="stat"><b>${likely}</b>streets with no published limit<br><small>probably free, check the sign</small></div>` : ''}</div>
${near.length ? `<h2>Car parks nearby</h2><p class="note">Cheapest published price for 2 hours on a weekday from 10am.</p><table><tr><th>Car park</th><th>2 hours</th></tr>${cps}</table>` : ''}
<h2>Streets</h2><table><tr><th>Street</th><th>Price</th><th>What the signs say</th></tr>${rows}</table>`;
    await mkdir(`dist/${path}`, { recursive: true });
    await writeFile(`dist/${path}index.html`, page(title, desc, body, path));
    pages.push({ path, name: a.name, city: cname, cid, n: a.kerbs.length });
  }
}
if (!any) { console.log('seo pages: no data in public/data, skipped'); process.exit(0); }
// Index of all areas, sitemap, robots.
const byCity = Object.entries(CITIES).map(([cid, [cname]]) => [cname, pages.filter((p) => p.cid === cid).sort((a, b) => a.name.localeCompare(b.name))]).filter(([, l]) => l.length);
await mkdir('dist/parking', { recursive: true });
await writeFile('dist/parking/index.html', page('Parking by area: Sydney, Melbourne, Brisbane, Perth | Kerb', 'Free streets, meter rates and car park prices by suburb, from council open data.',
  `<h1>Parking by area</h1>${byCity.map(([c, l]) => `<h2>${esc(c)}</h2><ul class="links">${l.map((p) => `<li><a href="${p.path.replace('parking/', '')}">${esc(p.name)}</a></li>`).join('')}</ul>`).join('')}`, 'parking/'));
const today = new Date().toISOString().slice(0, 10);
await writeFile('dist/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${SITE}</loc><lastmod>${today}</lastmod></url>\n<url><loc>${SITE}parking/</loc><lastmod>${today}</lastmod></url>\n${pages.map((p) => `<url><loc>${SITE}${p.path}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
await writeFile('dist/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
console.log(`seo pages: ${pages.length} area pages (${byCity.map(([c, l]) => `${c} ${l.length}`).join(', ')})`);
