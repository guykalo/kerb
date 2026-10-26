import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const b = await chromium.launch();
for (const [city, extra] of [['syd', ''], ['mel', ''], ['bne', ''], ['per', ''], ['air', '#at=-33.9268,151.1905'], ['mas', '#at=-33.9335,151.1800'], ['chp', '#at=-37.8395,144.9905'], ['fit', '#at=-37.7985,144.9785']]) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const logs = [];
  p.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  p.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await p.goto(`https://guykalo.github.io/kerb/${extra ? "" : "?city=" + city}${extra}`, { waitUntil: 'load' });
  await p.waitForTimeout(15000);
  await p.screenshot({ path: `out/${city}-map.png` });
  // open the panel and the first option
  try { await p.click('#handle'); await p.waitForTimeout(800); await p.screenshot({ path: `out/${city}-list.png` }); const opt = await p.$('.opt'); if (opt) { await opt.click(); await p.waitForTimeout(1500); await p.screenshot({ path: `out/${city}-detail.png`, fullPage: false }); } } catch (e) { logs.push('click failed ' + e.message); }
  if (city === 'syd') { await p.click('#cityBtn'); await p.waitForTimeout(400); await p.screenshot({ path: 'out/city-menu.png' }); }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`out/${city}-console.txt`, logs.join('\n'));
  await p.close();
}
await b.close();
