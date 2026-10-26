// Kerb health check. Reads the published data for every city (live site by default, or a local folder) and
// writes audit/report.md + audit/report.json: broken data, impossible rules, odd prices, and "free" claims in
// places where free parking would be surprising (so a person can check them). Run: node scripts/audit.mjs [base]
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { stateAt, costFor } from '../src/rules.js';

const BASE = process.argv[2] || 'https://guykalo.github.io/kerb/data/';
const CITIES = {
  syd: { dir: '', box: [150.5, -34.2, 151.5, -33.4], cores: [['Sydney CBD', 151.2073, -33.8688, 900], ['Parramatta CBD', 151.0035, -33.8155, 500], ['Bondi Junction', 151.2475, -33.8915, 350], ['Chatswood', 151.1815, -33.7968, 350], ['Mascot station', 151.1874, -33.9233, 300]] },
  mel: { dir: 'mel/', box: [144.3, -38.6, 145.8, -37.3], cores: [['Melbourne CBD', 144.9631, -37.8136, 700]] },
  bne: { dir: 'bne/', box: [152.5, -28, 153.6, -26.9], cores: [['Brisbane CBD', 153.0251, -27.4698, 600], ['Fortitude Valley', 153.0345, -27.4575, 300]] },
  per: { dir: 'per/', box: [115.4, -32.6, 116.4, -31.4], cores: [['Perth CBD', 115.8605, -31.9523, 600]] },
};
const get = async (p) => (/^https?:/.test(BASE) ? (await fetch(BASE + p)).json() : JSON.parse(await readFile(BASE + p, 'utf8')));
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110540);
const lineLen = (c) => c.slice(1).reduce((s, p, i) => s + dist(c[i], p), 0);
const mid = (c) => c[Math.floor(c.length / 2)];

const report = { at: new Date().toISOString(), cities: {} };
let md = `# Kerb audit ${report.at.slice(0, 16)}Z\n\n`;
for (const [id, city] of Object.entries(CITIES)) {
  const r = { problems: {}, examples: {}, stats: {} };
  const add = (kind, ex) => { r.problems[kind] = (r.problems[kind] || 0) + 1; if ((r.examples[kind] ||= []).length < 6) r.examples[kind].push(ex); };
  let K, R, C, M;
  try { [K, R, C, M] = await Promise.all([get(city.dir + 'kerbs.json'), get(city.dir + 'rules.json'), get(city.dir + 'carparks.json'), get(city.dir + 'meta.json')]); }
  catch (e) { report.cities[id] = { error: e.message }; md += `## ${id}\nCould not load data: ${e.message}\n\n`; continue; }
  r.stats = { kerbs: K.features.length, ruleSets: R.length, carParks: C.length, builtAt: M.builtAt, stale: M.stale || false };
  if (M.builtAt && Date.now() - new Date(M.builtAt) > 36 * 3600e3) add('data older than 36 hours', M.builtAt);

  // Rule sets
  R.forEach((s, i) => {
    for (const x of s.rules || []) {
      const [hrs, days, from, to, rate] = x;
      if (!Array.isArray(days) || !days.length || days.some((d) => d < 0 || d > 6)) add('rule with bad days', { set: i, rule: x });
      if (!(from >= 0 && to <= 24 && from < to)) add('rule with impossible times', { set: i, rule: x, text: s.text });
      if (rate > 25) add('meter rate over $25/hr', { set: i, rate, src: s.src, text: s.text });
      if (rate < 0 && rate !== -1) add('negative rate', { set: i, rate });
      if (hrs < 0 && hrs !== -1) add('negative time limit', { set: i, rule: x });
    }
    if (!s.src) add('rule set without a source', { set: i, text: s.text });
  });

  // Kerbs
  const names = new Map();
  for (const f of K.features) {
    const p = f.properties, c = f.geometry?.coordinates || [];
    if (c.length < 2) { add('kerb with no line', p); continue; }
    if (c.some((q) => q[0] < city.box[0] || q[0] > city.box[2] || q[1] < city.box[1] || q[1] > city.box[3])) add('kerb outside the city', { id: p.id, s: p.s, at: c[0] });
    const L = lineLen(c);
    if (L > 3000) add('kerb longer than 3 km', { id: p.id, s: p.s, len: Math.round(L), src: p.src });
    if (!p.s || /^unnamed/i.test(p.s) || !p.s.trim()) add('kerb without a street name', { id: p.id, src: p.src, at: mid(c) });
    if (p.k >= 0 && !R[p.k]) add('kerb points to a missing rule set', { id: p.id, k: p.k });
    names.set(p.src, (names.get(p.src) || 0) + 1);
  }
  r.stats.bySource = Object.fromEntries(names);

  // "Free for 2 hours at noon on a weekday" right in a busy centre: possible, but worth a human look.
  for (const [label, x, y, rad] of city.cores) {
    let free = 0, all = 0;
    for (const f of K.features) {
      const p = f.properties;
      if (p.k < 0 || p.lk) continue;
      const m = mid(f.geometry.coordinates);
      if (dist(m, [x, y]) > rad) continue;
      all++;
      const c = costFor(p, R, 2, 12, 2);
      // Only "free with no sign in force" (not a signed free 2P), which is where a missing sign would hide.
      if (c.ok && c.cost === 0 && !c.unknownRate && stateAt(p, R, 2, 12).kind === 'free') { free++; add(`no sign in force at Tue noon in ${label}`, { id: p.id, s: p.s, sd: p.sd, src: p.src, text: R[p.k]?.text?.slice(0, 120), at: m }); }
    }
    r.stats[`${label} kerbs`] = all;
    r.stats[`${label} free at Tue noon`] = free;
  }

  // Overlapping kerbs that disagree right now (same spot, one says free, one says no parking)
  const grid = new Map(), cell = (q) => `${Math.round(q[0] * 3000)}:${Math.round(q[1] * 3000)}`;
  for (const f of K.features) if (f.properties.k >= 0) { const k = cell(mid(f.geometry.coordinates)); (grid.get(k) || grid.set(k, []).get(k)).push(f); }
  for (const list of grid.values()) {
    if (list.length < 2) continue;
    const st = list.map((f) => [f, stateAt(f.properties, R, 2, 12)]);
    const fr = st.find(([, s]) => s.kind === 'free'), no = st.find(([, s]) => s.kind === 'restricted');
    if (fr && no && fr[0].properties.s === no[0].properties.s && (fr[0].properties.sd || '') === (no[0].properties.sd || '') && dist(mid(fr[0].geometry.coordinates), mid(no[0].geometry.coordinates)) < 8) add('same kerb both free and no parking at Tue noon', { free: [fr[0].properties.id, fr[0].properties.src, R[fr[0].properties.k]?.text?.slice(0, 80)], no: [no[0].properties.id, no[0].properties.src, R[no[0].properties.k]?.text?.slice(0, 80)], s: fr[0].properties.s });
  }

  // Car parks
  for (const cp of C) {
    if (!Array.isArray(cp.at) || cp.at.length !== 2) { add('car park without a location', { id: cp.id, name: cp.name }); continue; }
    if (cp.at[0] < city.box[0] || cp.at[0] > city.box[2] || cp.at[1] < city.box[1] || cp.at[1] > city.box[3]) add('car park outside the city', { id: cp.id, at: cp.at });
    for (const rt of cp.rates || []) {
      if (rt.kind === 'casual') {
        const b = rt.bands || [];
        for (let i = 1; i < b.length; i++) if (b[i][1] < b[i - 1][1] || b[i][0] <= b[i - 1][0]) add('car park bands not increasing', { id: cp.id, bands: b });
      }
      if (rt.kind === 'hourly' && !(rt.perHour > 0)) add('hourly rate without a price', { id: cp.id, rt });
      if (!Array.isArray(rt.days) || !rt.days.length) add('car park rate with no days', { id: cp.id, rt });
    }
  }

  report.cities[id] = r;
  md += `## ${id}\n${Object.entries(r.stats).filter(([k]) => k !== 'bySource').map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n- by source: ${JSON.stringify(r.stats.bySource)}\n\n`;
  const probs = Object.entries(r.problems).sort((a, b) => b[1] - a[1]);
  md += probs.length ? probs.map(([k, n]) => `### ${k} (${n})\n${r.examples[k].map((e) => `- \`${JSON.stringify(e).slice(0, 260)}\``).join('\n')}`).join('\n\n') + '\n\n' : 'No problems found.\n\n';
}
await mkdir('audit', { recursive: true });
await writeFile('audit/report.json', JSON.stringify(report, null, 1));
await writeFile('audit/report.md', md);
console.log(md.slice(0, 4000));
