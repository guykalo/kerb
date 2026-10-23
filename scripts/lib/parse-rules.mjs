// Parses City of Sydney meter sign text into structured rules.
// Input looks like: "2P 8AM-6PM MON-FRI, $7 /HR;4P 6PM-10PM MON-FRI, $7 /HR"
// Output rule: { p: hours allowed, d: [days 0=Sun..6=Sat], f: from hour, t: to hour, r: $ per hour, ph: applies on public holidays }

const DAY = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export function parseTime(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?(AM|PM)$/.exec(s.trim());
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3] === 'PM') h += 12;
  return h + (m[2] ? +m[2] / 60 : 0);
}

export function parseDays(s) {
  let txt = s.trim().toUpperCase();
  const ph = /PUBLIC HOLIDAYS/.test(txt);
  txt = txt.replace(/&?\s*PUBLIC HOLIDAYS/, '').trim();
  const days = new Set();
  for (const part of txt.split(/\s*[&,]\s*/).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => x.trim().slice(0, 3));
    if (!(a in DAY)) return null;
    if (!b) { days.add(DAY[a]); continue; }
    if (!(b in DAY)) return null;
    let d = DAY[a];
    for (let i = 0; i < 7; i++) { days.add(d); if (d === DAY[b]) break; d = (d + 1) % 7; }
  }
  return { days: [...days].sort(), ph };
}

const PART = /^(\d+(?:\/\d+)?)P\s+(\d{1,2}(?::\d{2})?(?:AM|PM))\s*-\s*(\d{1,2}(?::\d{2})?(?:AM|PM))\s+(.+?),\s*\$(\d+(?:\.\d+)?)\s*\/\s*HR$/i;

export function parsePart(raw) {
  const m = PART.exec(raw.trim());
  if (!m) return null;
  const [num, den] = m[1].split('/').map(Number);
  const p = den ? num / den : num;
  const f = parseTime(m[2]);
  let t = parseTime(m[3]);
  const dd = parseDays(m[4]);
  if (f == null || t == null || !dd) return null;
  const r = +m[5];
  // 12AM as an end time means midnight at the end of the day.
  if (t === 0) t = 24;
  if (f === 0 && t === 24) return [{ p, d: dd.days, f: 0, t: 24, r, ph: dd.ph }];
  if (t > f) return [{ p, d: dd.days, f, t, r, ph: dd.ph }];
  // Overnight, e.g. 6PM-8AM: split into evening on the listed days and early morning on the following days.
  return [
    { p, d: dd.days, f, t: 24, r, ph: dd.ph },
    { p, d: dd.days.map((x) => (x + 1) % 7).sort(), f: 0, t, r, ph: dd.ph },
  ];
}

export function parseSignText(text) {
  if (!text) return { rules: [], bad: [] };
  const rules = [];
  const bad = [];
  for (const part of String(text).split(';').map((x) => x.trim()).filter(Boolean)) {
    const r = parsePart(part);
    if (r) rules.push(...r); else bad.push(part);
  }
  return { rules, bad };
}
