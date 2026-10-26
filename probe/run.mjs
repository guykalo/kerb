// Probe round 6: City of Parramatta Traffic Committee items, from council agendas (businesspapers.parracity.nsw.gov.au).
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('out', { recursive: true });
await mkdir('tmp', { recursive: true });
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
const UA = { 'User-Agent': 'Mozilla/5.0 (Kerb parking map; github.com/guykalo/kerb)' };
const BP = 'https://businesspapers.parracity.nsw.gov.au/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, '-').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');

// 1. Meeting list per year (the page's own View form).
const r0 = await fetch(BP, { headers: UA });
const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
const html = await r0.text();
const urls = new Set([...html.matchAll(/URL=(Open\/[^"&'\s]+)/g)].map((m) => m[1]));
const hidden = (h) => Object.fromEntries([...h.matchAll(/<input[^>]+type="hidden"[^>]*>/g)].map((m) => [/name="([^"]+)"/.exec(m[0])?.[1], /value="([^"]*)"/.exec(m[0])?.[1] || '']).filter(([k]) => k));
const years = [...html.matchAll(/<option[^>]*value="(20\d\d)"/g)].map((m) => m[1]);
say('years offered', years.join(' '));
for (const y of years.filter((x) => +x >= 2017)) {
  const body = new URLSearchParams({ ...hidden(html), ddlCommittee: '1', ddlYear: y, ddlMonth: '0', btnView: 'View' });
  try {
    const r = await fetch(BP, { method: 'POST', body, headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Referer: BP } });
    const h = await r.text();
    const before = urls.size;
    for (const m of h.matchAll(/URL=(Open\/[^"&'\s]+)/g)) urls.add(m[1]);
    say('year', y, r.status, 'new docs', urls.size - before);
    if (urls.size === before) await writeFile(`out/bp-${y}.html`, h);
  } catch (e) { say('year failed', y, e.message); }
  await sleep(1000);
}
for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
  try { const x = await (await fetch(`${BP}Sitemap/Open/${y}/${String(m).padStart(2, '0')}/sitemap.xml`, { headers: UA })).text(); for (const u of x.matchAll(/URL=(Open\/[^<"&\s]+)/g)) urls.add(u[1]); } catch { /* none */ }
}
await writeFile('out/bp-all-urls.txt', [...urls].sort().join('\n'));
// 2. Council agendas: one document per meeting (web page preferred, else the PDF with attachments).
const meetings = new Map();
for (const u of urls) {
  const m = /Open\/\d{4}\/\d\d\/(OC|SP)_(\d{8})_AGN_(\d+)(_AT)?(_SUP)?(_WEB)?\.(htm|PDF)$/i.exec(u);
  if (!m || m[5]) continue;
  const key = `${m[1]}_${m[2]}`;
  const rank = m[6] ? 0 : (/htm/i.test(m[7]) ? 4 : 2) + (m[4] ? 1 : 0); // the _WEB page is only a frame
  if (!meetings.has(key) || meetings.get(key).rank < rank) meetings.set(key, { u, rank, date: m[2] });
}
say('meetings', meetings.size);
const items = [];
let i = 0;
for (const [key, { u, date }] of [...meetings].sort()) {
  i++;
  let t = '';
  try {
    const r = await fetch(`${BP}RedirectToDoc.aspx?URL=${u}`, { headers: UA, signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (/\.pdf$/i.test(u)) { await writeFile('tmp/a.pdf', Buffer.from(await r.arrayBuffer())); execFileSync('pdftotext', ['-layout', 'tmp/a.pdf', 'tmp/a.txt']); t = await readFile('tmp/a.txt', 'utf8'); }
    else t = text(await r.text());
  } catch (e) { say('doc failed', u, e.message); continue; }
  // Windows of text around every Traffic Committee mention and traffic item heading, merged.
  const flat = t.replace(/\r/g, '');
  const wins = [];
  for (const m of flat.matchAll(/Traffic Committee|Traffic Engineering Advisory|ITEM\s+\d{4}\s+[AB]\d+/gi)) wins.push([Math.max(0, m.index - 300), Math.min(flat.length, m.index + 7000)]);
  wins.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const w of wins) { const last = merged[merged.length - 1]; if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else merged.push([...w]); }
  const got = new Map();
  let segText = merged.map(([x, y]) => flat.slice(x, y)).filter((x) => /park|stopping|zone|\dP\b|permit/i.test(x)).join('\n=====\n').replace(/[ \t]+/g, ' ').slice(0, 150000);
  if (segText) got.set('all', { id: 'all', title: '', text: segText });
  for (const v of got.values()) items.push({ meeting: key, date: `${date.slice(0, 2)}/${date.slice(2, 4)}/${date.slice(4)}`, doc: u, ...v });
  say(i, key, u.split('/').pop(), 'chars', t.length, 'items', got.size);
}
await writeFile('out/parra-traffic-items.json', JSON.stringify(items, null, 1));
say('traffic items', items.length);
await writeFile('out/log.txt', log.join('\n'));
