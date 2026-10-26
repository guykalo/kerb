// Parking rule evaluation. A rule is [hours allowed, days[], from, to, $/hr, publicHolidays].
// Streety props: k = rule set index (-1 = no meter data), z = meter area (1 CBD, 2 inner), pa = permit area, f15 = free 15-minute zone.

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
// A limit of -1 means the council publishes the meter but not its time limit.
export const pLabel = (p) => (p < 0 ? '?P' : p === 0.25 ? '¼P' : p === 0.5 ? '½P' : `${p}P`);
export const pWords = (p) => (p < 0 ? 'the time on the sign' : p === 0.25 ? '15 minutes' : p === 0.5 ? '30 minutes' : p === 1 ? '1 hour' : `${p} hours`);
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
    // My car: motorbike bays for motorbikes, EV bays for electric cars (while charging), and no time limit in
    // the driver's own resident permit area when the sign says permit holders are excepted.
    if (on[6] === 1 && BEN.vehicle === 'moto' && /motor ?(bike|cycle)/i.test(on[7] || '')) return { kind: 'limit', rule: [24, on[1], on[2], on[3], 0, on[5], 0, 'Motorbike parking'], until: on[3], set };
    if (on[6] === 1 && BEN.vehicle === 'ev' && /\bEV\b|electric|charging/i.test(on[7] || '')) return { kind: 'limit', rule: [-1, on[1], on[2], on[3], 0, on[5], 0, 'EV charging bay, while charging'], until: on[3], set };
    if (on[6] !== 1 && on[0] > 0 && on[0] < 24 && permitMine(on[7])) return { kind: 'free', until: on[3], why: 'permit', set };
    // A mobility parking space is a free space for mobility permit holders (BEN is set before any call).
    if (on[6] === 1 && /mobility|disab/i.test(on[7] || '') && globalThis.__kerbMps) return { kind: 'limit', rule: [24, on[1], on[2], on[3], 0, on[5], 0, 'Mobility parking space'], until: on[3], set };
    if (on[6] === 1) return { kind: 'restricted', rule: on, until: on[3], note: on[7], set };
    return { kind: on[4] !== 0 ? 'meter' : 'limit', rule: on, until: on[3], set }; // rate -1 = meter, rate not published
  }
  if (set.u) return { kind: 'free', until: 24, why: 'unrestricted', set };
  if (set.g === 'unknown') {
    // Only some times are published (a clearway): outside them Streety doesn't know, so it never says free.
    const next = today.filter((r) => r[2] > h).map((r) => r[2]);
    return { kind: 'unknown', until: next.length ? Math.min(...next) : 24, partial: true, set };
  }
  if (set.g === 'edges') {
    // Only part of the sign is known (a council decision, a meter zone): before the first time on it and after the
    // last there's no limit, but a gap in the middle of the day is usually something else (a clearway), so check.
    const before = today.some((r) => r[3] <= h), after = today.some((r) => r[2] > h);
    const next = today.filter((r) => r[2] > h).map((r) => r[2]);
    if (before && after) return { kind: 'unknown', until: Math.min(...next), partial: true, set };
    if (!today.length && ![1, 2, 3, 4, 5].every((d) => rulesFor(set, d).length) && set.rules.length) return { kind: 'unknown', until: 24, partial: true, set };
    // Before the first time on the sign: free only if the sign starts in the morning (or it's still early).
    // After the last: free only if the sign runs into the evening (or it's evening now). A sign that only covers
    // 4pm-7pm says nothing about the rest of the working day.
    if (today.length) {
      const first = Math.min(...today.map((r) => r[2])), last = Math.max(...today.map((r) => r[3]));
      if (after && first > 9.5 && h >= 7) return { kind: 'unknown', until: first, partial: true, set };
      if (!after && last < 18 && h < 18.5) return { kind: 'unknown', until: 24, partial: true, set };
    }
    return { kind: 'free', until: next.length ? Math.min(...next) : 24, why: 'outside-sign', set };
  }
  if (set.g === 'free') {
    // Signed rules: outside the times on the sign there's no limit.
    const next = today.filter((r) => r[2] > h).map((r) => r[2]);
    return { kind: 'free', until: next.length ? Math.min(...next) : 24, why: 'outside-sign', set };
  }
  if (!today.length) {
    // A meter that runs every weekday but not today (usually Sunday): free today. A meter that only runs on some
    // weekdays (e.g. Sunday-only on a street that's a bus lane on weekdays): something else is signed today.
    if ([1, 2, 3, 4, 5].every((d) => rulesFor(set, d).length)) return { kind: 'free', until: 24, why: 'no-meter-day', set };
    return { kind: 'unknown', until: 24, partial: true, set };
  }
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
export const BEN = {
  _mps: false,
  get mps() { return this._mps; },
  set mps(v) { this._mps = !!v; globalThis.__kerbMps = !!v; },
  // "My car": vehicle ('car' | 'moto' | 'ev') and a resident parking permit area (as Streety names it, e.g. "Area 22").
  vehicle: 'car',
  permit: '',
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Does this sign wording or permit area name the driver's own permit area? ("Permit holders Area 22 excepted")
export function permitMine(text) {
  if (!BEN.permit || !text) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${esc(BEN.permit)}($|[^A-Za-z0-9])`, 'i').test(String(text));
}
const mpsLimit = (p) => (p < 0 || p > 0.5 ? Infinity : p === 0.5 ? 2 : 0.5);

// Can you park for `stay` hours from day/h, and what does it cost?
export function costFor(props, rules, day, h, stay) {
  if (props.k < 0) return { ok: null, why: 'No published rules for this kerb yet' };
  const set = rules[props.k];
  const step = 0.25, n = Math.max(1, Math.round(stay / step));
  let cost = 0, run = 0, ref = null, paid = 0, firstPaidAt = null, rate = 0, waived = 0, unknownRate = false, limitUnknown = false, unknown = false;
  for (let i = 0; i < n; i++) {
    const t = h + i * step, d = (day + Math.floor(t / 24)) % 7, hh = t % 24;
    const s = stateAt(props, rules, d, hh);
    if (s.kind === 'restricted') return { ok: false, why: `${s.note || 'No parking'} ${s.until < 24 || hh > 0 ? `${fmtTime(hh)}-${fmtTime(s.until)}` : ''}`.trim() };
    if (s.kind === 'unknown') unknown = true;
    if (s.kind !== 'meter' && s.kind !== 'limit') { run = 0; ref = null; continue; }
    if (s.rule !== ref) { run = 0; ref = s.rule; }
    run += step;
    if (s.rule[0] < 0) limitUnknown = true;
    const limit = s.rule[0] < 0 ? Infinity : BEN.mps ? mpsLimit(s.rule[0]) : s.rule[0];
    if (run > limit + 1e-9) return { ok: false, why: BEN.mps ? `${limit === 0.5 ? '30-minute' : `${limit}-hour`} limit with a permit until ${fmtTime(s.rule[3])}` : `${pLabel(s.rule[0])} limit until ${fmtTime(s.rule[3])}` };
    if (s.kind === 'limit') continue;
    if (BEN.mps) { waived += step; continue; }
    const tier = s.rule[8] && run > s.rule[8][0] + 1e-9 ? s.rule[8][1] : s.rule[4];
    if (s.rule[4] < 0) unknownRate = true; else cost += tier * step;
    paid += step;
    if (firstPaidAt == null) { firstPaidAt = t; rate = s.rule[4]; }
  }
  if (unknown) return { ok: null, partial: true, why: 'Only some of the signs here are published' };
  // Ticket machines in free 15-minute zones give the first quarter hour free.
  const quarterFree = set.q || props.f15;
  if (quarterFree && paid > 0) cost = Math.max(0, cost - Math.min(paid, 0.25) * (cost / paid));
  return { ok: true, cost, quarterFree: !!quarterFree && stay <= 0.25 && !unknownRate, paidHours: paid, freeHours: stay - paid, firstPaidAt, rate, waived, unknownRate, limitUnknown };
}

// Category used for colouring the kerb for the chosen stay.
export function category(props, rules, day, h, stay) {
  if (props.k < 0) return props.lk ? 'likely' : props.pa ? (permitMine(props.pa) ? 'free' : 'permit') : 'unknown';
  const c = costFor(props, rules, day, h, stay);
  if (c.ok === null) return 'unknown';
  if (!c.ok) { const k = stateAt(props, rules, day, h).kind; return k === 'meter' || k === 'limit' ? 'short' : 'restricted'; }
  return c.cost === 0 && !c.unknownRate ? 'free' : 'paid';
}

// One line in plain English about right now.
export function plainNow(props, rules, day, h) {
  const s = stateAt(props, rules, day, h);
  if (s.kind === 'unknown' && props.lk) return `No resident permit scheme on this street, so it's usually unrestricted parking. The council doesn't publish its signs, so check for any time limits.`;
  if (s.kind === 'unknown' && s.partial) {
    const cw = /^clearway/i.test(s.set.text || '');
    if (!rulesFor(s.set, day).length && s.set.rules.some((r) => r[4] !== 0)) {
      // A CBD meter that only runs some days: on the other days the kerb is usually a bus lane or clearway.
      const on = [...new Set(s.set.rules.flatMap((r) => r[1]))].sort();
      return `The meter here only runs ${fmtDays(on)}. On other days kerbs like this are usually a clearway, bus lane or loading zone, which the council doesn't publish, so check the sign before you park.`;
    }
    return `${cw ? 'No clearway right now' : 'The published signs here don\'t cover this time'}${s.until < 24 ? ` (next one starts at ${fmtTime(s.until)})` : ''}. Other signs on this kerb aren't published, so check them before you park. Published: ${s.set.text}.`;
  }
  if (s.kind === 'unknown') return props.pa
    ? `Resident permit ${props.pa}. The council hasn't published the signs here, so check the sign: visitors are usually time-limited.`
    : `The council hasn't published the signs for this kerb yet. Check the sign before you park.`;
  const permit = s.rule && s.rule[7] ? ` ${s.rule[7]}.` : '';
  if (s.kind === 'meter') return `${s.rule[4] < 0 ? 'Pay at the meter (the council doesn\'t publish the rate)' : `Pay ${money(s.rule[4])} an hour${s.rule[8] ? ` (${money(s.rule[8][1])} an hour after ${pWords(s.rule[8][0])})` : ''}`}, up to ${pWords(s.rule[0])}, until ${fmtTime(s.rule[3])}.${permit}`;
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
    if (r && r[0] > 0 && r[0] <= 1) v += 0.06; // short limits usually mean high turnover demand
  }
  return Math.max(0, Math.min(1, v));
}
export const busyLevel = (v) => (v < 0.45 ? 'easy' : v < 0.72 ? 'moderate' : 'hard');
export const BUSY_WORD = { easy: 'Easy', moderate: 'Some luck needed', hard: 'Hard' };
