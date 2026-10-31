// Phone screenshots of Streety's main tasks, for checking a redesign before it goes live (workflow "UX preview").
//   node scripts/ux-shots.mjs <base url> <out dir>
// Each task is a list of steps. A step that can't find its element is recorded (not fatal), so the same script
// shows what changed between the old and new layout. Writes <out>/<task>-<n>.png and <out>/report.md.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || 'ux-shots';
await mkdir(OUT, { recursive: true });

// Saturday 7pm Sydney, so "plan ahead" results are stable between runs.
const GLEBE = '#at=-33.87755,151.18527';
const TASKS = [
  { name: 'start', url: '', steps: [['shot']] },
  { name: 'list', url: '', steps: [['tap', ['#handle', '[data-sheet-toggle]']], ['shot']] },
  { name: 'street', url: GLEBE, steps: [['shot'], ['tap', ['#handle', '[data-sheet-toggle]']], ['shot'], ['scroll', '#body'], ['shot']] },
  { name: 'option', url: '', steps: [['tap', ['#handle', '[data-sheet-toggle]']], ['tap', ['.opt', '[data-option]']], ['shot'], ['scroll', '#body'], ['shot']] },
  { name: 'search', url: '', steps: [['tap', ['#q', '[data-search]']], ['type', 'Glebe Point Road'], ['wait', 2500], ['shot'], ['key', 'Enter'], ['wait', 2500], ['shot']] },
  { name: 'when', url: '', steps: [['tap', ['#ask', '[data-when]', '.ask-edit']], ['wait', 600], ['shot']] },
];

const b = await chromium.launch();
let md = `# UX screenshots\n\n${new Date().toISOString()}  ·  ${BASE}\n`;
for (const t of TASKS) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'Australia/Sydney', geolocation: { latitude: -33.8722, longitude: 151.2075 }, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  const errs = [], notes = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  let n = 0;
  try {
    await p.goto(BASE + t.url, { waitUntil: 'load', timeout: 60000 });
    await p.waitForFunction(() => !/Loading the kerbs/.test(document.body.innerText), null, { timeout: 45000 }).catch(() => notes.push('still loading after 45 s'));
    await p.waitForTimeout(2500);
    for (const [act, arg] of t.steps) {
      if (act === 'shot') { await p.screenshot({ path: `${OUT}/${t.name}-${++n}.png` }); continue; }
      if (act === 'wait') { await p.waitForTimeout(arg); continue; }
      if (act === 'type') { await p.keyboard.type(arg, { delay: 30 }); continue; }
      if (act === 'key') { await p.keyboard.press(arg); continue; }
      if (act === 'scroll') { await p.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollTop += 600; }, arg); await p.waitForTimeout(500); continue; }
      if (act === 'tap') {
        let ok = false;
        for (const sel of arg) { const el = await p.$(sel); if (el && (await el.isVisible())) { await el.click({ timeout: 3000 }).catch(() => {}); ok = true; break; } }
        if (!ok) notes.push(`no ${arg.join(' / ')}`);
        await p.waitForTimeout(900);
      }
    }
    // Tap targets smaller than 44 px that are visible now (WCAG 2.5.8 asks 24, Apple/Google 44-48).
    const small = await p.evaluate(() => [...document.querySelectorAll('button, a, [role=button], input, select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight && (r.width < 44 || r.height < 44); }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.id || e.className).trim().slice(0, 30)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`).slice(0, 12));
    if (small.length) notes.push(`small tap targets on screen: ${small.join('; ')}`);
  } catch (e) { errs.push(e.message); }
  md += `\n## ${t.name}\n${n} shot(s)${notes.length ? `\n- ${notes.join('\n- ')}` : ''}${errs.length ? `\n- ERRORS: ${errs.join(' | ')}` : ''}\n`;
  await ctx.close();
}
await b.close();
await writeFile(`${OUT}/report.md`, md);
console.log(md);
