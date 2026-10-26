import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36', viewport: { width: 1280, height: 2000 } });
const pages = {
  'syd-dropup2': 'https://www.sydneyairport.com.au/parking',
  'syd-faq': 'https://www.sydneyairport.com.au/info-sheet/parking-faq',
  'syd-dropup': 'https://prebook.sydneyairport.com.au/en/parkinginformation/drive-up-rates/',
  'syd-pickup': 'https://www.sydneyairport.com.au/pickup',
  'syd-intl': 'https://prebook.sydneyairport.com.au/en/parkinginformation/international-parking/',
  'syd-dom': 'https://prebook.sydneyairport.com.au/en/parkinginformation/domestic-parking/',
  'syd-bluemu': 'https://prebook.sydneyairport.com.au/en/parkinginformation/blu-emu-parking/',
};
for (const [k, u] of Object.entries(pages)) {
  const p = await ctx.newPage();
  try {
    await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await p.waitForTimeout(20000);
    // open any accordions / tabs so hidden rate tables render
    for (const el of await p.$$('button[aria-expanded="false"], summary')) { try { await el.click({ timeout: 1000 }); } catch {} }
    await p.waitForTimeout(1500);
    await writeFile(`out/${k}.txt`, `${u}\n\n${await p.evaluate(() => document.body.innerText)}`);
    await p.screenshot({ path: `out/${k}.png`, fullPage: true });
  } catch (e) { await writeFile(`out/${k}.txt`, `${u}\nERROR ${e.message}`); }
  await p.close();
}
await b.close();
