// Phone screenshots of Streety's main tasks, for checking a redesign before it goes live (workflow "UX preview").
//   node scripts/ux-shots.mjs <base url> <out dir>
// Each task is a list of steps. A step that can't find its element is recorded (not fatal), so the same script
// shows what changed between the old and new layout. Writes <out>/<task>-<n>.png and <out>/report.md.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || 'ux-shots';
await mkdir(OUT, { recursive: true });

// The clock is fixed at Wednesday 4 Nov 2026, 10am Sydney, so "now" screens are the same between runs.
// Only the "start" task sees the first-open welcome; the others start as a returning visitor.
const NOW = new Date('2026-11-04T10:00:00+11:00');
const GLEBE = '#at=-33.87755,151.18527';
const TASKS = [
  { name: 'start', fresh: true, url: '', steps: [['shot'], ['tap', ['[data-welcome-skip]']], ['wait', 600], ['shot']] },
  { name: 'list', url: '', steps: [['tap', ['#handle']], ['shot'], ['tap', ['[data-filter=carparks]']], ['shot'], ['tap', ['.rows .opt']], ['wait', 700], ['shot']] },
  { name: 'street', url: GLEBE, steps: [['wait', 800], ['visible', '[data-act=directions]'], ['visible', '.trust'], ['shot'], ['tap', ['#handle']], ['shot'], ['scroll', '#body'], ['shot']] },
  { name: 'option', url: '', steps: [['tap', ['#handle']], ['tap', ['.rows .opt', '.opt']], ['wait', 700], ['visible', '[data-act=directions]'], ['shot'], ['scroll', '#body'], ['shot']] },
  { name: 'search', url: '', steps: [['tap', ['#q']], ['type', 'Glebe Point Road'], ['wait', 2500], ['shot'], ['key', 'Enter'], ['wait', 2500], ['shot']] },
  { name: 'when', url: '', steps: [['tap', ['[data-when]', '#ask']], ['wait', 600], ['shot']] },
  // Sat 7pm for 2 hours from the pill: pill, Sat, 7pm (2 hours is the default; tapped anyway to be sure).
  { name: 'plan', url: '', steps: [['tap', ['[data-when]']], ['tap', ['[data-dow="6"]']], ['tap', ['[data-time="19"]']], ['tap', ['[data-stay="2"]']], ['shot'], ['tap', ['[data-when-done]']], ['tap', ['#handle']], ['shot'], ['tap', ['.rows .opt']], ['wait', 700], ['shot']] },
  { name: 'directions', url: GLEBE, steps: [['tap', ['[data-act=directions]']], ['wait', 600], ['shot'], ['key', 'Escape'], ['wait', 300], ['tap', ['[data-act=park]']], ['wait', 900], ['shot']] },
  // Contrast check in the dark theme.
  { name: 'dark', dark: true, url: GLEBE, steps: [['shot'], ['tap', ['#handle']], ['scroll', '#body'], ['shot']] },
];

const b = await chromium.launch();
let md = `# UX screenshots\n\n${new Date().toISOString()}  ·  ${BASE}\n`;
for (const t of TASKS) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: t.dark ? 'dark' : 'light', timezoneId: 'Australia/Sydney', geolocation: { latitude: -33.8722, longitude: 151.2075 }, permissions: ['geolocation'] });
  try { await ctx.clock.setFixedTime(NOW); } catch { /* older Playwright: real time */ }
  if (!t.fresh) await ctx.addInitScript(() => { try { localStorage.setItem('streety-welcomed', '1'); localStorage.setItem('streety-legend', '1'); } catch { /* no storage */ } });
  const p = await ctx.newPage();
  const errs = [], notes = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  let n = 0;
  try {
    await p.goto(BASE + t.url, { waitUntil: 'load', timeout: 60000 });
    await p.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 45000 }).catch(() => notes.push('still loading after 45 s'));
    await p.waitForTimeout(2500);
    for (const [act, arg] of t.steps) {
      if (act === 'shot') { await p.screenshot({ path: `${OUT}/${t.name}-${++n}.png` }); continue; }
      if (act === 'wait') { await p.waitForTimeout(arg); continue; }
      if (act === 'type') { await p.keyboard.type(arg, { delay: 30 }); continue; }
      if (act === 'key') { await p.keyboard.press(arg); continue; }
      // Is this element fully on screen and not covered (by the sheet edge or anything else)?
      if (act === 'visible') {
        const r = await p.evaluate((q) => { const el = document.querySelector(q); if (!el) return null; const b = el.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight, ok: b.top >= 0 && b.bottom <= innerHeight && !!top && (el === top || el.contains(top)) }; }, arg);
        notes.push(r ? `${arg} ${r.ok ? 'visible' : 'NOT fully visible'} (top ${r.top}, bottom ${r.bottom} of ${r.h})` : `no ${arg}`);
        continue;
      }
      if (act === 'scroll') { await p.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollTop += 600; }, arg); await p.waitForTimeout(500); continue; }
      if (act === 'tap') {
        let ok = false;
        for (const sel of arg) { const el = await p.$(sel); if (el && (await el.isVisible())) { await el.click({ timeout: 4000 }).catch((e) => notes.push(`tap ${sel} failed: ${e.message.split('\n').slice(0, 3).join(' ').slice(0, 220)}`)); ok = true; break; } }
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
