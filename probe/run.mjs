// Probe round 7: Strathfield Council meeting papers -> Local Transport Forum / traffic items (Homebush, Strathfield).
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('out', { recursive: true });
await mkdir('tmp', { recursive: true });
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
const UA = { 'User-Agent': 'Mozilla/5.0 (Kerb parking map; github.com/guykalo/kerb)' };
const BASE = 'https://www.strathfield.nsw.gov.au';
const get = async (u) => { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; };
const abs = (h) => new URL(h.replace(/&amp;/g, '&'), BASE).href;

// 1. Every meeting page, following the list's pagination.
const meetingPages = new Set(), listPages = new Set([`${BASE}/Council/Council-Meetings`]), done = new Set();
while ([...listPages].some((p) => !done.has(p))) {
  const p = [...listPages].find((x) => !done.has(x)); done.add(p);
  try {
    const h = await (await get(p)).text();
    for (const m of h.matchAll(/href="([^"]*Council-Meetings\/[^"#?]+)"/g)) { const u = abs(m[1]); if (!/Council-Meetings-Live|Council-Meetings\/?$/i.test(u)) meetingPages.add(u); }
    for (const m of h.matchAll(/href="([^"]*Council-Meetings\?[^"]*page[^"]*)"/gi)) listPages.add(abs(m[1]));
  } catch (e) { say('list failed', p, e.message); }
  if (done.size > 40) break;
}
say('list pages', done.size, 'meetings', meetingPages.size);
// 2. Agenda / minutes PDFs from each meeting page.
const pdfs = new Map();
for (const mp of meetingPages) {
  try {
    const h = await (await get(mp)).text();
    for (const m of h.matchAll(/href="([^"]+\.pdf)"[^>]*>([^<]*)/gi)) { const u = abs(m[1]); if (/agenda|minutes|attachment|business/i.test(u + m[2])) pdfs.set(u, { meeting: mp.split('/').pop(), label: m[2].trim() }); }
  } catch (e) { say('meeting failed', mp, e.message); }
}
say('pdfs', pdfs.size);
await writeFile('out/strath-pdfs.json', JSON.stringify([...pdfs], null, 1));
// 3. Traffic items: pages around "Local Transport Forum", "Traffic Committee", "parking restriction".
const items = [];
for (const [u, info] of pdfs) {
  if (!/agenda|attachment|business/i.test(u + info.label)) continue;
  try {
    await writeFile('tmp/a.pdf', Buffer.from(await (await get(u)).arrayBuffer()));
    execFileSync('pdftotext', ['-layout', 'tmp/a.pdf', 'tmp/a.txt']);
    const t = await readFile('tmp/a.txt', 'utf8');
    const pages = t.split('\f');
    const hit = pages.map((p, i) => [i, p]).filter(([, p]) => /Local Transport Forum|Traffic Committee|Local Traffic/i.test(p) && /park|stopping|\dP\b|loading|zone/i.test(p));
    for (const [i] of hit) items.push({ meeting: info.meeting, doc: u, page: i + 1, text: pages.slice(i, i + 2).join('\n').replace(/[ \t]+/g, ' ').slice(0, 9000) });
    say(info.meeting, u.split('/').pop(), 'pages', pages.length, 'hits', hit.length);
  } catch (e) { say('pdf failed', u, e.message); }
}
await writeFile('out/strath-traffic-items.json', JSON.stringify(items, null, 1));
say('strathfield items', items.length);
await writeFile('out/log.txt', log.join('\n'));
