import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const b = await chromium.launch();
for (const [name, q] of [['cbd', '#at=-33.8705,151.2075'], ['newtown', '#at=-33.8975,151.1795'], ['bondi', '#at=-33.8915,151.2745']]) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await p.goto('https://guykalo.github.io/kerb/' + q, { waitUntil: 'load' }); await p.waitForTimeout(12000);
  await p.evaluate(() => document.querySelector('.opt')?.click()); await p.waitForTimeout(2500);
  await p.evaluate(() => { document.getElementById('panel').classList.add('open'); const b = document.getElementById('body'); const f = b.querySelector('.fines'); if (f) b.scrollTop = f.offsetTop - 120; });
  await p.waitForTimeout(800);
  await p.screenshot({ path: `out/${name}-fines.png` });
  await p.close();
}
await b.close();
