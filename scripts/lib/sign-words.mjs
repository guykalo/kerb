// Reads NSW parking sign wording, as printed on a sign, typed by a council, or read by OCR from a photo,
// into Kerb's rule tuples: [hours, days[], from, to, $/hr, publicHolidays, 0 park / 1 no parking, note].
//   "2P 8am-10pm, Permit Holders Excepted Area 22"
//   "2P 8AM-10AM 3PM-6PM MON-FRI 8AM-12:30PM SAT"   (several times under one header)
//   "No Stopping"   "Loading Zone 6am-10am Mon-Fri"   "1/2P Ticket 8.30am-6pm"
// Each sign panel starts with a header (2P, No Parking, Loading Zone...). Times and days that follow belong
// to it; a time with no days of its own takes the next days written, and a panel with no days applies daily.

const DAY = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const ALL = [0, 1, 2, 3, 4, 5, 6];

// OCR and typing slips: B/8, O/0, l/1, en dashes, "a.m.", "midday".
export function cleanSignText(raw) {
  return ` ${String(raw || '')} `
    .replace(/[‐-―−~]/g, '-')
    .replace(/½/g, '1/2').replace(/¼/g, '1/4')
    .replace(/\ba\.?\s?m\.?(?=[\s,;)\-]|$)/gi, 'AM').replace(/\bp\.?\s?m\.?(?=[\s,;)\-]|$)/gi, 'PM')
    .replace(/\b(midday|noon)\b/gi, '12PM').replace(/\bmidnight\b/gi, '12AM')
    .replace(/\b([B8])(?=\s?(AM|PM)\b)/gi, '8').replace(/(\d)[oO](?=\d|\s?(AM|PM))/g, '$10').replace(/\b[oO](?=\d)/g, '0')
    .replace(/\b[lI](?=\d)/g, '1').replace(/(\d)[lI]\b/g, '$11')
    .replace(/(\d)\s*[.:]\s*(\d\d)\s*(AM|PM)/gi, '$1:$2$3')
    .replace(/(\d)\s+(AM|PM)\b/gi, '$1$2')
    .replace(/\b(\d{1,2})(?:[:.](\d\d))?(AM|PM)?\s*(?:-|to)\s*(\d{1,2})(?:[:.](\d\d))?(AM|PM)\b/gi,
      (m, h1, m1, a1, h2, m2, a2) => `${h1}${m1 ? `:${m1}` : ''}${(a1 || guessAmPm(+h1, +h2, a2)).toUpperCase()}-${h2}${m2 ? `:${m2}` : ''}${a2.toUpperCase()} `)
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .replace(/\b([A-Z]*)0([A-Z]+)\b|\b([A-Z]+)0\b/g, (m) => m.replace(/0/g, 'O')) // M0N -> MON
    .replace(/\b5AT\b/g, 'SAT').replace(/\bFR1\b/g, 'FRI');
}
// "8-6PM" means 8AM-6PM; "6-10PM" means 6PM-10PM: the first time is AM if it would otherwise come after the second.
function guessAmPm(h1, h2, a2) {
  const end = (h2 % 12) + (/pm/i.test(a2) ? 12 : 0);
  return (h1 % 12) + 12 < end || /am/i.test(a2) ? (/am/i.test(a2) ? 'AM' : 'PM') : 'AM';
}
export function toHour(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?(AM|PM)$/.exec(s);
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3] === 'PM') h += 12;
  return h + (m[2] ? +m[2] / 60 : 0);
}
function daysFrom(txt) {
  const out = new Set();
  for (const part of txt.split(/\s*(?:&|,|AND)\s*/).filter(Boolean)) {
    const [a, b] = part.split(/\s*-\s*/).map((x) => x.slice(0, 3));
    if (!(a in DAY)) continue;
    if (!b || !(b in DAY)) { out.add(DAY[a]); continue; }
    let d = DAY[a];
    for (let i = 0; i < 7; i++) { out.add(d); if (d === DAY[b]) break; d = (d + 1) % 7; }
  }
  return [...out].sort();
}

const HEAD = /(\b\d{1,2}(?:\/\d)?\s?P\b|\bP\s?\d{1,2}\b(?!\s?(?:AM|PM))|NO STOPPING|NO PARKING|LOADING ZONE|BUS ZONE|BUS LANE|TRANSIT LANE|TAXI ZONE|MAIL ZONE|CAR ?SHARE|MOBILITY PARKING|DISABILITY PARKING|DISABLED|CLEARWAY|WORKS ZONE|PERMIT HOLDERS ONLY|AUTHORISED (?:COUNCIL )?VEHICLES)/g;
const TIME = /\b(\d{1,2}(?::\d\d)?(?:AM|PM))-(\d{1,2}(?::\d\d)?(?:AM|PM))\b/g;
const DAYS = /\b((?:MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*(?:\s*(?:-|&|,|AND)\s*(?:MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*)*)/g;

// Returns { panels: [{ head, kind, hours, times: [[from, to, days]], permit, ticket, rate, ph, text }], rules: [...tuples] }
export function readSign(raw) {
  const txt = cleanSignText(raw).replace(/\(?\s*1\/4\s?P\s+FREE\s*\)?/g, ' ').replace(/\b(?:NO PARKING|NO STOPPING|TAXI ZONE|LOADING ZONE|BUS ZONE)\s*;?\s*OTHER TIMES\b/g, ' ');
  const heads = [...txt.matchAll(HEAD)];
  const panels = [];
  heads.forEach((h, i) => {
    const body = txt.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const head = h[1].replace(/\s/g, ' ').trim();
    const p = { head, text: body.trim(), times: [], ph: /PUBLIC HOLIDAY/.test(body) };
    const lim = /^(\d{1,2})(?:\/(\d))?\s?P$/.exec(head) || /^P\s?(\d{1,2})$/.exec(head);
    if (lim) { p.kind = 'limit'; p.hours = /^P/.test(head) ? +lim[1] / 60 : lim[2] ? +lim[1] / +lim[2] : +lim[1]; }
    else if (/NO STOPPING|CLEARWAY|BUS LANE|TRANSIT LANE/.test(head)) p.kind = 'nostop';
    else if (/NO PARKING/.test(head)) p.kind = 'nopark';
    else if (/WORKS ZONE/.test(head)) p.kind = 'works';
    else p.kind = 'zone';
    if (/TICKET|METER|PAY\b|PARKMETER|\$/.test(body) && p.kind === 'limit') p.ticket = true;
    const rate = /\$\s?(\d+(?:\.\d\d)?)\s*(?:\/|PER)\s*(?:HR|HOUR)/.exec(body);
    if (rate) p.rate = +rate[1];
    const permit = /PERMIT HOLDERS? EXCEPTED(?:\s*(?:AREA|ZONE)\s*([A-Z0-9]{1,6}(?:\s*(?:&|AND|,)\s*(?:AREA\s*)?[A-Z0-9]{1,6})*))?/.exec(body);
    if (permit) p.permit = permit[1] ? permit[1].replace(/\s*(?:AND|,)\s*/g, ' & ').replace(/AREA\s*/g, '') : 'yes';
    if (/PERMIT HOLDERS ONLY/.test(head)) p.kind = 'nopark', p.permit = p.permit || 'only';
    // Walk times and days in reading order.
    const marks = [...[...body.matchAll(TIME)].map((m) => ({ i: m.index, t: [toHour(m[1]), toHour(m[2])] })), ...[...body.matchAll(DAYS)].map((m) => ({ i: m.index, d: daysFrom(m[1]) }))].sort((a, b) => a.i - b.i);
    let pending = [];
    for (const m of marks) {
      if (m.t && m.t[0] != null && m.t[1] != null) pending.push(m.t);
      else if (m.d && m.d.length) {
        if (pending.length) { for (const t of pending) p.times.push([t[0], t[1], m.d]); pending = []; }
        else if (p.times.length && p.times[p.times.length - 1][2] === ALL) p.times[p.times.length - 1][2] = m.d; // "8AM-6PM" then days on the next line
        else p.times.push([0, 24, m.d]);
      }
    }
    for (const t of pending) p.times.push([t[0], t[1], ALL]);
    if (!p.times.length) p.times.push([0, 24, ALL]);
    panels.push(p);
  });
  return { panels, rules: panels.flatMap(panelRules), text: txt.trim() };
}

const NOTE = { nostop: 'No stopping', nopark: 'No parking', works: 'Works zone' };
export function panelRules(p) {
  const out = [];
  for (const [f0, t0, days] of p.times) {
    let f = f0, t = t0 === 0 ? 24 : t0;
    const note = p.kind === 'limit'
      ? [p.permit ? `Permit holders excepted${p.permit !== 'yes' ? `, area ${p.permit}` : ''}` : '', p.ticket && !p.rate ? 'Ticket' : ''].filter(Boolean).join('. ')
      : p.kind === 'zone' ? titleWords(p.head) : NOTE[p.kind] + (p.permit === 'only' ? ', permit holders only' : '');
    const tuple = (a, b, d) => [p.kind === 'limit' ? p.hours : 0, d, a, b, p.kind === 'limit' && p.ticket ? (p.rate ?? -1) : 0, p.ph ? 1 : 0, p.kind === 'limit' ? 0 : 1, note];
    if (t > f) out.push(tuple(f, t, days));
    else { out.push(tuple(f, 24, days)); out.push(tuple(0, t, days.map((x) => (x + 1) % 7).sort())); }
  }
  return out;
}
const titleWords = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Plain English for a panel: "2P 8am-10pm every day, permit holders excepted (area 22)".
export function describePanel(p) {
  const hm = (h) => { const hh = Math.floor(h) % 24, mm = Math.round((h % 1) * 60); return `${hh % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${hh < 12 ? 'am' : 'pm'}`; };
  const dw = (d) => (d.length === 7 ? 'every day' : d.join() === '1,2,3,4,5' ? 'Mon-Fri' : d.join() === '1,2,3,4,5,6' ? 'Mon-Sat' : d.join() === '0,6' ? 'Sat-Sun' : d.map((x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(', '));
  const when = p.times.map(([f, t, d]) => (f === 0 && t === 24 ? `all day ${dw(d)}` : `${hm(f)}-${hm(t)} ${dw(d)}`)).join(', ');
  const what = p.kind === 'limit' ? `${p.hours < 1 ? `${Math.round(p.hours * 60)} min` : `${p.hours}P`}${p.ticket ? ' ticket' : ''}` : p.kind === 'zone' ? titleWords(p.head) : NOTE[p.kind];
  return `${what} ${when}${p.permit && p.permit !== 'only' ? `, permit holders excepted${p.permit !== 'yes' ? ` (area ${p.permit})` : ''}` : ''}`;
}
