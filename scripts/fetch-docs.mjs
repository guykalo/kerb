// Downloads the council documents listed in data/doc-urls.txt into docs/ (uploaded as a build artifact),
// so they can be read and turned into Kerb rules. Pages marked "page" are crawled for document links.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const UA = { 'User-Agent': 'Mozilla/5.0 (Kerb parking map; github.com/guykalo/kerb)', Accept: '*/*' };
const lines = (await readFile('data/doc-urls.txt', 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const urls = new Set();
const DOC = /\.(pdf|docx?|xlsx?)(\.aspx)?($|\?)|\/downloads\/file\/|download_file|ArticleDocuments/i;
async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try { const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(45000) }); return r; } catch (e) { if (i >= tries) throw e; await new Promise((s) => setTimeout(s, 2000 * i)); }
  }
}
for (const l of lines) {
  if (l.startsWith('page ')) {
    const page = l.slice(5).trim();
    try {
      const r = await get(page); if (!r.ok) { console.log(`page ${r.status}: ${page}`); continue; }
      const html = await r.text();
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        const u = new URL(m[1].replace(/&amp;/g, '&'), page).href;
        if (DOC.test(u)) urls.add(u);
      }
      console.log(`page ok: ${page}`);
    } catch (e) { console.log(`page failed: ${page} ${e.message}`); }
  } else if (l.startsWith('range ')) {
    const [, tpl, a, b] = l.split(/\s+/);
    for (let n = +a; n <= +b; n++) urls.add(tpl.replace('{n}', n));
  } else urls.add(l);
}
await mkdir('docs', { recursive: true });
const index = [];
let i = 0;
for (const u of urls) {
  i++;
  try {
    const r = await get(u);
    const type = r.headers.get('content-type') || '';
    if (!r.ok || /text\/html/.test(type)) { console.log(`skip ${r.status} ${type.split(';')[0]}: ${u}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    const cd = r.headers.get('content-disposition') || '';
    const named = (/filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd) || [])[1];
    const base = decodeURIComponent(named || new URL(r.url).pathname.split('/').filter(Boolean).pop() || `doc${i}`).replace(/\.aspx$/i, '').replace(/[^\w.\- ]+/g, '_').slice(0, 90);
    const ext = /\.\w{3,4}$/.test(base) ? '' : /pdf/.test(type) ? '.pdf' : /word|officedocument/.test(type) ? '.docx' : '';
    const file = `${String(i).padStart(3, '0')}-${base}${ext}`;
    await writeFile(`docs/${file}`, buf);
    index.push({ url: u, file, bytes: buf.length, type });
    console.log(`ok ${buf.length} ${file}`);
  } catch (e) { console.log(`failed: ${u} ${e.message}`); }
}
await writeFile('docs/index.json', JSON.stringify(index, null, 1));
console.log(`${index.length} documents`);
