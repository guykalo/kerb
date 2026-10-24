// Parses Waverley Council's free-text kerb rules into rule tuples.
// Examples:
//   "P120 8am-10pm, allowed permit holders area 4"
//   "1P meter registration 8am-6pm 4P meter registration 6pm-10pm"
//   "P30 8am-7pm, P120 7pm-9pm (november to april), P30 8am-7pm, P120 7pm-9pm (may to october)"
//   "no stopping 7am-9am mon-fri", "bus zone", "unrestricted"
// Rule tuple: [hours allowed, days[], from, to, $/hr, publicHolidays, kind (0 park, 1 no parking), note]

const DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sunday: 0, monday: 1, saturday: 6 };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ALL = [0, 1, 2, 3, 4, 5, 6];

const TIME = String.raw`(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm))`;
const DAYS = String.raw`((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*-\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)?(?:\s*&\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*)`;
const SEASON = String.raw`\(?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\s*(?:-|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\)?`;

function hour(s) {
  const m = /^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)$/.exec(s.trim());
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3] === 'pm') h += 12;
  return h + (m[2] ? +m[2] / 60 : 0);
}
function days(s) {
  if (!s) return ALL;
  const out = new Set();
  for (const part of s.split('&').map((x) => x.trim())) {
    const [a, b] = part.split('-').map((x) => DAY[x.trim().slice(0, 3)]);
    if (a == null) continue;
    if (b == null) { out.add(a); continue; }
    for (let d = a, i = 0; i < 7; i++, d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return out.size ? [...out].sort() : ALL;
}
function inSeason(a, b, month) {
  const s = MON[a.slice(0, 3)], e = MON[b.slice(0, 3)];
  if (!s || !e) return true;
  return s <= e ? month >= s && month <= e : month >= s || month <= e;
}
function limitHours(tok) {
  let m = /^(\d+)\/(\d+)p$/.exec(tok); if (m) return +m[1] / +m[2];
  m = /^(\d+)p$/.exec(tok); if (m) return +m[1];
  m = /^p(\d+)$/.exec(tok); if (m) return +m[1] / 60;
  return null;
}

const ZONES = /(no stopping|no parking|loading zone|truck zone|bus zone|bus stop|mail zone|taxi zone|works zone|mobility parking|motorbikes only|motorcycles only|car share|coaches only|police|pick up and drop off)/;

// Splits a clause list so that a trailing "(november to april)" applies to everything since the last season marker.
function seasonChunks(text) {
  const chunks = [];
  const re = new RegExp(String.raw`\((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(?:-|to)\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\)`, 'g');
  let last = 0, m;
  while ((m = re.exec(text))) { chunks.push({ text: text.slice(last, m.index), season: m[0] }); last = m.index + m[0].length; }
  chunks.push({ text: text.slice(last), season: null });
  return chunks.filter((c) => c.text.trim());
}

export function parseWaverley(raw, { month = 1, rate = 0 } = {}) {
  const text = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return { rules: [], unrestricted: false, unknown: true };
  if (text === 'unrestricted') return { rules: [], unrestricted: true };
  const permit = (/(?:permit holders (?:excepted|allowed)?|allowed permit holders)\s*(area[^,]*)/.exec(text) || [])[1];
  const rules = [];
  for (const chunk of seasonChunks(text)) {
    if (chunk.season) {
      const s = new RegExp(SEASON).exec(chunk.season);
      if (s && !inSeason(s[1], s[2], month)) continue;
    }
    // Walk through the chunk picking out "<limit> [meter|ticket] [time-time] [days] [season]" and "<zone> [time-time] [days]".
    const unit = new RegExp(String.raw`(?:^|[\s,])((?:\d+\/\d+|\d+)p|p\d+)\b((?:\s*(?:meter registration|meter|ticket))*)(?:\s*${TIME}\s*-\s*${TIME})?(?:\s+${DAYS})?(?:\s+${SEASON})?|${ZONES.source}((?:\s*ticket)?)(?:\s*${TIME}\s*-\s*${TIME})?(?:\s+${DAYS})?`, 'g');
    let m;
    while ((m = unit.exec(chunk.text))) {
      if (m[1]) {
        const p = limitHours(m[1]);
        if (p == null) continue;
        if (m[6] && !inSeason(m[6], m[7], month)) continue;
        const paid = /meter|ticket/.test(m[2] || '');
        const f = m[3] ? hour(m[3]) : 0, t = m[4] ? (hour(m[4]) || 24) : 24;
        if (/motor/.test(chunk.text.slice(m.index, m.index + 40))) { rules.push([0, ALL, 0, 24, 0, 1, 1, 'Motorbikes only']); continue; }
        push(rules, [p, days(m[5]), f, t, paid ? rate : 0, 1, 0, permit ? `Permit holders excepted (${permit.trim()})` : '']);
      } else if (m[8]) {
        const zone = m[8];
        const f = m[10] ? hour(m[10]) : 0, t = m[11] ? (hour(m[11]) || 24) : 24;
        push(rules, [0, days(m[12]), f, t, 0, 1, 1, zone.replace(/^./, (c) => c.toUpperCase())]);
      }
    }
  }
  return { rules, unrestricted: false, unknown: rules.length === 0 };
}

// Overnight periods become two rules, like the City of Sydney parser.
function push(out, r) {
  const [p, d, f, t] = r;
  if (t > f || (f === 0 && t === 24)) out.push(r);
  else { out.push([p, d, f, 24, ...r.slice(4)]); out.push([p, d.map((x) => (x + 1) % 7).sort(), 0, t, ...r.slice(4)]); }
}

export function parseFee(s) {
  const m = /\$\s*(\d+(?:\.\d+)?)/.exec(String(s || ''));
  return m ? +m[1] : 0;
}
