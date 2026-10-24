// Parking rule evaluation. A rule is [hours allowed, days[], from, to, $/hr, publicHolidays].
// Kerb props: k = rule set index (-1 = no meter data), z = meter area (1 CBD, 2 inner), pa = permit area, f15 = free 15-minute zone.

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fmtTime(h) {
  h = ((h % 24) + 24) % 24;
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  const H = Math.floor(h), m = Math.round((h - H) * 60);
  return `${H % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${H < 12 ? 'am' : 'pm'}`;
}
export function fmtClock(h) {
  const H = Math.floor(h), m = Math.round((h - H) * 60);
  return `${H % 12 || 12}:${String(m).padStart(2, '0')}${H < 12 ? 'am' : 'pm'}`;
}
export function fmtDays(d) {
  const s = [...d].sort().join();
  if (s === '0,1,2,3,4,5,6') return 'Every day';
  if (s === '1,2,3,4,5') return 'Mon-Fri';
  if (s === '1,2,3,4,5,6') return 'Mon-Sat';
  if (s === '0,6') return 'Sat-Sun';
  if (s === '0') return 'Sunday';
  if (s === '6') return 'Saturday';
  return d.map((x) => DAYS[x]).join(', ');
}
export const pLabel = (p) => (p === 0.25 ? '¼P' : p === 0.5 ? '½P' : `${p}P`);
export const pWords = (p) => (p === 0.25 ? '15 minutes' : p === 0.5 ? '30 minutes' : p === 1 ? '1 hour' : `${p} hours`);
export const money = (v) => (v === 0 ? 'Free' : `$${(Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, '')}`);

const DAYTIME_FROM = 9; // a meter period starting at or before this is the "first thing in the morning" one
const EVENING_FROM = 18; // a meter period ending at or after this marks the start of free night parking
const NIGHT_UNTIL = 7; // before this, with no meter running, kerbs are treated as free overnight

export function rulesFor(set, day) {
  return set.rules.filter((r) => r[1].includes(day));
}

// What applies on this kerb at this moment.
// Returns { kind: 'meter'|'free'|'restricted'|'unknown', rule?, until? }
export function stateAt(props, rules, day, h) {
  if (props.k < 0) return { kind: 'unknown' };
  const set = rules[props.k];
  const today = rulesFor(set, day);
  // When periods overlap, a no-parking period wins over parking.
  const on = today.find((r) => r[6] === 1 && h >= r[2] && h < r[3]) || today.find((r) => h >= r[2] && h < r[3]);
  if (on) {
    if (on[6] === 1) return { kind: 'restricted', rule: on, until: on[3], note: on[7], set };
    return { kind: on[4] !== 0 ? 'meter' : 'limit', rule: on, until: on[3], set }; // rate -1 = meter, rate not published
  }
  if (set.u) return { kind: 'free', until: 24, why: 'unrestricted', set };
  if (set.g === 'free') {
    // Signed rules: outside the times on the sign there's no limit.
    const next = today.filter((r) => r[2] > h).map((r) => r[2]);
    return { kind: 'free', until: next.length ? Math.min(...next) : 24, why: 'outside-sign', set };
  }
  if (!today.length) return { kind: 'free', until: 24, why: 'no-meter-day', set };
  const first = Math.min(...today.map((r) => r[2]));
  const last = Math.max(...today.map((r) => r[3]));
  if (h >= last && last >= EVENING_FROM) return { kind: 'free', until: 24, why: 'after-hours', set };
  if (h < first && first <= DAYTIME_FROM) return { kind: 'free', until: first, why: 'before-hours', set };
  if (h < NIGHT_UNTIL) return { kind: 'free', until: Math.min(first, NIGHT_UNTIL), why: 'night', set };
  const next = today.filter((r) => r[2] > h).map((r) => r[2]);
  return { kind: 'restricted', until: next.length ? Math.min(...next) : 24, set };
}

// Concessions the driver has. mps = NSW mobility parking permit: free at council and street meters, and
// signed limits over 30 minutes don't apply (30 minutes becomes 2 hours, shorter limits become 30 minutes).
// No-parking, no-stopping, loading and bus zones still apply. Private car parks don't give these concessions.
export const BEN = { mps: false };
const mpsLimit = (p) => (p > 0.5 ? Infinity : p === 0.5 ? 2 : 0.5);

// Can you park for `stay` hours from day/h, and what does it cost?
export function costFor(props, rules, day, h, stay) {
  if (props.k < 0) return { ok: null, why: 'No published rules for this kerb yet' };
  const set = rules[props.k];
  const step = 0.25, n = Math.max(1, Math.round(stay / step));
  let cost = 0, run = 0, ref = null, paid = 0, firstPaidAt = null, rate = 0, waived = 0, unknownRate = false;
  for (let i = 0; i < n; i++) {
    const t = h + i * step, d = (day + Math.floor(t / 24)) % 7, hh = t % 24;
    const s = stateAt(props, rules, d, hh);
    if (s.kind === 'restricted') return { ok: false, why: `${s.note || 'No parking'} ${s.until < 24 || hh > 0 ? `${fmtTime(hh)}-${fmtTime(s.until)}` : ''}`.trim() };
    if (s.kind !== 'meter' && s.kind !== 'limit') { run = 0; ref = null; continue; }
    if (s.rule !== ref) { run = 0; ref = s.rule; }
    run += step;
    const limit = BEN.mps ? mpsLimit(s.rule[0]) : s.rule[0];
    if (run > limit + 1e-9) return { ok: false, why: BEN.mps ? `${limit === 0.5 ? '30-minute' : `${limit}-hour`} limit with a permit until ${fmtTime(s.rule[3])}` : `${pLabel(s.rule[0])} limit until ${fmtTime(s.rule[3])}` };
    if (s.kind === 'limit') continue;
    if (BEN.mps) { waived += step; continue; }
    if (s.rule[4] < 0) unknownRate = true; else cost += s.rule[4] * step;
    paid += step;
    if (firstPaidAt == null) { firstPaidAt = t; rate = s.rule[4]; }
  }
  // Ticket machines in free 15-minute zones give the first quarter hour free.
  const quarterFree = set.q || props.f15;
  if (quarterFree && paid > 0) cost = Math.max(0, cost - Math.min(paid, 0.25) * (cost / paid));
  return { ok: true, cost, quarterFree: !!quarterFree && stay <= 0.25 && !unknownRate, paidHours: paid, freeHours: stay - paid, firstPaidAt, rate, waived, unknownRate };
}

// Category used for colouring the kerb for the chosen stay.
export function category(props, rules, day, h, stay) {
  if (props.k < 0) return props.lk ? 'likely' : props.pa ? 'permit' : 'unknown';
  const c = costFor(props, rules, day, h, stay);
  if (!c.ok) { const k = stateAt(props, rules, day, h).kind; return k === 'meter' || k === 'limit' ? 'short' : 'restricted'; }
  return c.cost === 0 && !c.unknownRate ? 'free' : 'paid';
}

// One line in plain English about right now.
export function plainNow(props, rules, day, h) {
  const s = stateAt(props, rules, day, h);
  if (s.kind === 'unknown' && props.lk) return `No resident permit scheme on this street, so it's usually unrestricted parking. The council doesn't publish its signs, so check for any time limits.`;
  if (s.kind === 'unknown') return props.pa
    ? `Resident permit ${props.pa}. The council hasn't published the signs here, so check the sign: visitors are usually time-limited.`
    : `The council hasn't published the signs for this kerb yet. Check the sign before you park.`;
  const permit = s.rule && s.rule[7] ? ` ${s.rule[7]}.` : '';
  if (s.kind === 'meter') return `${s.rule[4] < 0 ? 'Pay at the meter (the council doesn\'t publish the rate)' : `Pay ${money(s.rule[4])} an hour`}, up to ${pWords(s.rule[0])}, until ${fmtTime(s.rule[3])}.${permit}`;
  if (s.kind === 'limit') return `Free for up to ${pWords(s.rule[0])}${s.rule[3] < 24 || s.rule[2] > 0 ? ` until ${fmtTime(s.rule[3])}` : ''}.${permit}`;
  if (s.kind === 'restricted' && s.note) return `${s.note}${s.until < 24 ? ` until ${fmtTime(s.until)}` : ''}. You can't park here.`;
  if (s.kind === 'restricted') return `No ticket parking until ${fmtTime(s.until)}. Usually a clearway, bus or loading zone at this time.`;
  if (s.why === 'unrestricted') return 'Unrestricted parking: free with no time limit.';
  if (s.why === 'outside-sign') return s.until < 24 ? `Free with no limit until ${fmtTime(s.until)}, when the sign's times start.` : `The sign's times have finished for ${DAYS_LONG[day]}, so it's free with no limit.`;
  if (s.why === 'before-hours') return `Free until the meters start at ${fmtTime(s.until)}.`;
  if (s.why === 'night') return `Free overnight until ${fmtTime(s.until)}. Check the sign for early clearways.`;
  if (s.why === 'after-hours') return `Free for the rest of the night. The meters have finished for ${DAYS_LONG[day]}.`;
  return `No meter hours on ${DAYS_LONG[day]}s here, so it's free. Check the sign for any other limits.`;
}

// Day timeline: segments across 0-24 with kind for drawing.
export function dayTimeline(props, rules, day) {
  const out = [];
  let cur = null;
  for (let q = 0; q < 96; q++) {
    const h = q / 4, s = stateAt(props, rules, day, h);
    const key = s.kind + (s.rule ? s.rule.join('|') : '');
    if (!cur || cur.key !== key) { cur = { key, kind: s.kind, rule: s.rule, from: h, to: h + 0.25 }; out.push(cur); }
    else cur.to = h + 0.25;
  }
  return out;
}

/* ---------- busyness estimate ---------- */
// Profiles per day (Sun..Sat), five bands: late 12-6am, morning 6-11, midday 11-3, arvo 3-7, evening 7-12.
const PROFILES = {
  cbd: [[.15, .25, .55, .5, .4], [.15, .8, .9, .85, .5], [.15, .85, .95, .9, .55], [.15, .85, .95, .9, .6], [.15, .85, .95, .9, .7], [.2, .8, .9, .85, .8], [.3, .45, .8, .8, .8]],
  village: [[.3, .5, .8, .75, .6], [.3, .55, .65, .65, .6], [.3, .55, .65, .65, .65], [.3, .55, .7, .7, .7], [.3, .6, .7, .7, .8], [.35, .6, .75, .8, .9], [.4, .7, .9, .9, .9]],
  beach: [[.4, .9, .98, .95, .7], [.3, .45, .6, .55, .45], [.3, .45, .6, .55, .45], [.3, .45, .6, .55, .45], [.3, .5, .65, .6, .55], [.35, .55, .7, .7, .75], [.45, .9, .98, .95, .85]],
  resi: [[.8, .65, .7, .7, .75], [.8, .45, .4, .5, .8], [.8, .45, .4, .5, .8], [.8, .45, .4, .5, .8], [.8, .45, .45, .55, .8], [.8, .5, .5, .6, .8], [.8, .6, .7, .7, .8]],
};
export const BANDS = [['Morning', 1], ['Midday', 2], ['Arvo', 3], ['Evening', 4], ['Late', 0]];
export const band = (h) => (h < 6 ? 0 : h < 11 ? 1 : h < 15 ? 2 : h < 19 ? 3 : 4);
export function busy(props, rules, day, h) {
  const prof = props.z === 1 ? 'cbd' : props.z === 3 ? 'beach' : props.k >= 0 && rules[props.k] && !rules[props.k].u ? 'village' : 'resi';
  let v = PROFILES[prof][day][band(h)];
  if (props.k >= 0) {
    const r = rulesFor(rules[props.k], day).find((x) => h >= x[2] && h < x[3]);
    if (r && r[0] <= 1) v += 0.06; // short limits usually mean high turnover demand
  }
  return Math.max(0, Math.min(1, v));
}
export const busyLevel = (v) => (v < 0.45 ? 'easy' : v < 0.72 ? 'moderate' : 'hard');
export const BUSY_WORD = { easy: 'Easy', moderate: 'Some luck needed', hard: 'Hard' };
