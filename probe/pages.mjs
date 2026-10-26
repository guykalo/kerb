import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36', viewport: { width: 1280, height: 2000 } });
const p = await ctx.newPage();
const u = 'https://prebook.sydneyairport.com.au/en/parkinginformation/drive-up-rates/';
await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForTimeout(15000);
const tabs = ['Blu Emu', 'P1 Prime Park', 'P2', 'P3 & P3 Express Pick-up', 'P7', 'P9 (Public Pick-up)', 'T1 Quick Park'];
let out = u + '\n';
for (const t of tabs) {
  try {
    const el = p.getByText(t, { exact: true }).last();
    await el.click({ timeout: 5000 });
    await p.waitForTimeout(2500);
    const txt = await p.evaluate(() => [...document.querySelectorAll('table')].filter((x) => x.offsetParent).map((x) => x.innerText).join('\n---\n'));
    out += `\n===== ${t}\n${txt}\n`;
  } catch (e) { out += `\n===== ${t}\nERROR ${e.message}\n`; }
}
await writeFile('out/syd-rates.txt', out);
await p.screenshot({ path: 'out/syd-rates.png', fullPage: true });
await b.close();
