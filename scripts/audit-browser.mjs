// Opens the live app for each city on a phone-sized screen, records page errors, failed requests and load time,
// and saves screenshots of the map, the options list and the first option, into audit/.
import { chromium } from 'playwright';
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
const BASE = process.argv[2] || 'https://guykalo.github.io/kerb/';
await mkdir('audit/shots', { recursive: true });
const b = await chromium.launch();
const views = [['syd', '?city=syd'], ['mel', '?city=mel'], ['bne', '?city=bne'], ['per', '?city=per'], ['syd-airport', '#at=-33.9335,151.18'], ['syd-parra', '#at=-33.8155,151.0035'], ['mel-chapel', '#at=-37.8395,144.9905']];
let md = '\n## Browser\n';
for (const [name, q] of views) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [], failed = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('requestfailed', (r) => failed.push(`${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  p.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 120)}`); });
  const t0 = Date.now();
  try {
    await p.goto(BASE + q, { waitUntil: 'load', timeout: 60000 });
    await p.waitForTimeout(10000);
    await p.screenshot({ path: `audit/shots/${name}-map.png` });
    try { await p.click('#handle', { timeout: 3000 }); await p.waitForTimeout(800); } catch {}
    await p.screenshot({ path: `audit/shots/${name}-list.png` });
    const opt = await p.$('.opt');
    if (opt) { await opt.click(); await p.waitForTimeout(1200); await p.screenshot({ path: `audit/shots/${name}-detail.png` }); }
  } catch (e) { errs.push('load: ' + e.message); }
  md += `- **${name}**: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${errs.length} errors, ${failed.length} failed requests${errs.length ? `\n  - ${errs.slice(0, 5).join('\n  - ')}` : ''}${failed.length ? `\n  - ${failed.slice(0, 5).join('\n  - ')}` : ''}\n`;
  await p.close();
}
await b.close();
await appendFile('audit/report.md', md);
console.log(md);
