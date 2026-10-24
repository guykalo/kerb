// Downloads council parking decisions (the record of every sign a council's traffic committee approves) so
// they can be turned into kerb rules. City of Sydney: Local Pedestrian, Cycling, Traffic Calming and Transport
// Forum (committee 138), 2017 onwards -> docs/decisions-cos.json [{ id, title, date, rec }].
// Inner West: Local Traffic Committee / Local Transport Forum minutes -> docs/minutes-iw.json [{ path, date, text }].
// Run: node scripts/fetch-decisions.mjs [fromYear]
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const BASE = 'https://meetings.cityofsydney.nsw.gov.au/';
const from = +(process.argv[2] || 2017), to = new Date().getFullYear();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BASE + path, { headers: { 'User-Agent': 'kerb-parking-map/1.0 (free parking map; github.com/guykalo/kerb)' }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.text();
    } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return '';
}
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, '-').replace(/\s+/g, ' ');
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

await mkdir('docs', { recursive: true });
let old = [];
try { old = JSON.parse(await readFile('docs/decisions-cos.json', 'utf8')); } catch { /* first run */ }
const have = new Map(old.filter((d) => d.rec).map((d) => [d.id, d]));

const meetings = new Set();
for (let y = from; y <= to; y++) {
  const html = await get(`ieListMeetings.aspx?CId=138&Year=${y}`);
  for (const m of html.matchAll(/href="(ieListDocuments\.aspx\?CId=138&amp;MId=\d+[^"]*)"/g)) meetings.add(m[1].replace(/&amp;/g, '&'));
}
console.log(`meetings: ${meetings.size}`);

const items = new Map();
await pool([...meetings], 6, async (m) => {
  const html = await get(m);
  let title = null;
  for (const a of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = a[1].replace(/&amp;/g, '&'), tx = text(a[2]).trim();
    if (/^documents\/s\d+/.test(href) && !/^(Attachment|Plan)/i.test(tx)) title = tx.replace(/ PDF \d+ KB$/, '');
    const id = /ieDecisionDetails\.aspx\?AIId=(\d+)/.exec(href)?.[1];
    if (id && title) { items.set(id, title); title = null; }
  }
});
const keep = [...items].filter(([, t]) => /Parking|Meter|No Stopping|Loading Zone|Car Share|Bus Zone|Mail Zone|Taxi|Clearway/i.test(t) && !/Temporary|Works Zone|Mobile Crane|Road Closure|Street Event|Special Event|Construction Zone|Filming/i.test(t));
console.log(`parking decisions: ${keep.length} (${have.size} already downloaded)`);

const out = [];
await pool(keep, 6, async ([id, title]) => {
  if (have.has(id)) { out.push(have.get(id)); return; }
  const t = text(await get(`ieDecisionDetails.aspx?AIId=${id}`));
  const rec = (/Decisions?:(.*?)(?:Voting Members|Advice|Report author|Reasons for the decision)/.exec(t) || [])[1]?.trim() || '';
  const date = (/Date of decision: (\d\d\/\d\d\/\d{4})/.exec(t) || [])[1] || '';
  out.push({ id, title, date, rec });
});
out.sort((a, b) => +a.id - +b.id);
await writeFile('docs/decisions-cos.json', JSON.stringify(out, null, 0));
console.log(`saved ${out.length}, with text: ${out.filter((d) => d.rec).length}`);

// ---------- Inner West minutes ----------
const IW = 'https://innerwest.infocouncil.biz/';
const list = new Set((await readFile('data/iw-minutes.txt', 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
try { // the front page lists this year's meetings, so new minutes are picked up without editing the list
  const r = await fetch(IW, { signal: AbortSignal.timeout(30000) });
  for (const m of (await r.text()).matchAll(/URL=(Open\/\d{4}\/\d\d\/LT[CF]_\d{8}_MIN_[\w]*?WEB\.htm)/gi)) list.add(m[1]);
} catch { /* use the list */ }
let oldIw = [];
try { oldIw = JSON.parse(await readFile('docs/minutes-iw.json', 'utf8')); } catch { /* first run */ }
const haveIw = new Map(oldIw.filter((d) => d.text).map((d) => [d.path, d]));
const iw = [];
await pool([...list], 4, async (path) => {
  if (haveIw.has(path)) { iw.push(haveIw.get(path)); return; }
  let html = '';
  for (let i = 0; i < 3 && !html; i++) { try { const r = await fetch(IW + path.replace(/_WEB\.htm$/i, '.HTM'), { signal: AbortSignal.timeout(40000) }); if (r.ok) html = await r.text(); } catch { await sleep(2000); } }
  const dm = /_(\d\d)(\d\d)(\d{4})_/.exec(path);
  iw.push({ path, date: dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : '', text: html ? text(html) : '' });
});
iw.sort((a, b) => a.path.localeCompare(b.path));
await writeFile('docs/minutes-iw.json', JSON.stringify(iw));
console.log(`Inner West minutes: ${iw.length}, with text: ${iw.filter((d) => d.text).length}`);
