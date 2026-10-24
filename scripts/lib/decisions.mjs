// Turns City of Sydney traffic committee decisions into Kerb street entries. A decision reads like:
//   "...endorse the reallocation of parking on the northern side of Hollis Lane, Newtown between the points
//    5 metres and 18 metres (two car spaces) east of Georgina Street as: "2P 8am-10pm, Permit Holders
//    Excepted Area 22"."
// Longer ones list parts (A), (B)... each with its own side, distances, cross street or sign, inheriting
// whatever they don't say from the opening sentence. Only what can be read with confidence becomes an entry;
// the rest is counted so it can be checked by hand. Ticket (paid) parking is left to the meter data.
import { readSign } from './sign-words.mjs';

// Rough suburb centres: the street and its cross street are looked for within 2.5 km of these.
export const SUBURBS = {
  newtown: [151.179, -33.8975], erskineville: [151.186, -33.903], alexandria: [151.196, -33.908], redfern: [151.204, -33.893],
  waterloo: [151.207, -33.9], zetland: [151.209, -33.907], rosebery: [151.204, -33.918], beaconsfield: [151.201, -33.912],
  eveleigh: [151.192, -33.896], darlington: [151.195, -33.891], chippendale: [151.198, -33.887], camperdown: [151.177, -33.889],
  glebe: [151.185, -33.879], 'forest lodge': [151.178, -33.881], annandale: [151.17, -33.881], ultimo: [151.197, -33.879],
  pyrmont: [151.194, -33.87], haymarket: [151.204, -33.88], sydney: [151.2093, -33.8688], 'surry hills': [151.211, -33.886],
  darlinghurst: [151.219, -33.879], 'east sydney': [151.217, -33.876], woolloomooloo: [151.222, -33.87], 'potts point': [151.225, -33.869],
  'elizabeth bay': [151.229, -33.872], 'rushcutters bay': [151.229, -33.875], paddington: [151.231, -33.884], 'moore park': [151.22, -33.895],
  'centennial park': [151.233, -33.898], 'millers point': [151.204, -33.859], 'dawes point': [151.207, -33.856], 'the rocks': [151.208, -33.859],
  barangaroo: [151.201, -33.862], 'st peters': [151.18, -33.913], 'woolloomooloo bay': [151.222, -33.869], 'strawberry hills': [151.21, -33.891],
  // Inner West
  balmain: [151.18, -33.857], 'balmain east': [151.191, -33.857], birchgrove: [151.182, -33.851], rozelle: [151.171, -33.862],
  lilyfield: [151.162, -33.874], leichhardt: [151.156, -33.883], stanmore: [151.165, -33.894], enmore: [151.174, -33.9],
  petersham: [151.155, -33.894], lewisham: [151.15, -33.896], marrickville: [151.155, -33.911], 'dulwich hill': [151.139, -33.905],
  sydenham: [151.167, -33.916], tempe: [151.159, -33.924], 'summer hill': [151.138, -33.892], ashfield: [151.126, -33.889],
  croydon: [151.115, -33.882], 'croydon park': [151.107, -33.897], haberfield: [151.139, -33.88], 'dobroyd point': [151.145, -33.873],
  'hurlstone park': [151.132, -33.909], ashbury: [151.12, -33.898],
};
// Entries read from Inner West committee minutes (data/decisions-iw.json) into map entries.
export function minutesToEntries(list) {
  const out = [], skipped = { place: 0, sign: 0, suburb: 0 };
  for (const e of list) {
    const area = SUBURBS[String(e.suburb || '').toLowerCase()];
    if (!area) { skipped.suburb++; continue; }
    if (!(e.a && e.b) && !(e.from && e.to)) { skipped.place++; continue; }
    const unrestricted = /^unrestricted$/i.test(e.sign || '');
    const rules = unrestricted ? [] : readSign(e.sign || '').rules;
    if (!unrestricted && !rules.length) { skipped.sign++; continue; }
    if (/TICKET|METER/i.test(e.sign || '')) continue; // paid kerbs come from the meter list
    const side = (e.side || []).map((x) => String(x).toLowerCase());
    out.push({ street: e.street, suburb: e.suburb, area, side: side.length ? side : ['both'], ...(e.a && e.b ? { a: e.a, b: e.b } : { from: e.from, to: e.to }), rules, text: unrestricted ? 'Unrestricted' : e.sign, src: 'iwdec', date: e.date, ref: e.ref });
  }
  return { entries: out, skipped };
}
const ROAD = "(?:Street|St|Lane|Road|Rd|Avenue|Ave|Place|Parade|Way|Grove|Terrace|Crescent|Close|Drive|Walk|Square|Boulevard|Highway|Circuit|Row|Mall|Esplanade|Broadway)";
const NAME = `((?:[A-Z][\\w'’.-]*\\s+){0,4}?${ROAD}\\b|Broadway)`;
const SIDE = { northern: 'north', southern: 'south', eastern: 'east', western: 'west', north: 'north', south: 'south', east: 'east', west: 'west' };
const clean = (s) => s.replace(/\bSt\b/, 'Street').replace(/\bRd\b/, 'Road').replace(/\bAve\b/, 'Avenue').replace(/[’]/g, "'").trim();

export function decisionsToEntries(list) {
  const entries = [], skipped = { deferred: 0, ticket: 0, nosign: 0, noplace: 0, suburb: 0 }, made = [];
  for (const d of list) {
    let t = (d.rec || '').replace(/^[\d/]+\s*/, '').replace(/\s+/g, ' ');
    const dec = /\bDecision\b(.*?)(?:Background|$)/.exec(t)?.[1] || '';
    if (/deferred|not (?:be )?(?:endorsed|supported|approved)|withdrawn|did not support|rejected/i.test(dec)) { skipped.deferred++; continue; }
    t = t.replace(/\bDecision\b.*$/, '').replace(/\bBackground\b.*$/, '').replace(/^Recommendation\s*/, '');
    const titlePlace = /-\s*([^-]+?),\s*([A-Za-z ]+)$/.exec(d.title || '');
    const suburb = (/(?:side of|in|parking in)\s+[A-Z][\w'’ .-]*?,\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/.exec(t)?.[1] || titlePlace?.[2] || '').trim();
    const area = SUBURBS[suburb.toLowerCase()];
    if (!area) { skipped.suburb++; continue; }
    // Split into the opening sentence and lettered parts.
    const parts = t.split(/\s(?=\([A-Z]\)\s)|\s·\s/);
    const head = parts[0];
    const quotes = (s) => [...new Set([...s.matchAll(/[“"'‘]([^“"”'’]{2,160})[”"'’]/g)].map((m) => m[1].trim()).filter((q) => /\d|NO |ZONE|PARKING|STOPPING|LANE/i.test(q)))];
    const ctx = {
      street: clean(new RegExp(`side of ${NAME}`).exec(head)?.[1] || new RegExp(`parking (?:in|on) ${NAME}`).exec(head)?.[1] || titlePlace?.[1] || ''),
      side: SIDE[/(northern|southern|eastern|western) side/.exec(head)?.[1]] || null,
      dir: null, cross: null,
      signs: quotes(head.split(/between|following/i)[0] + ' ' + (head.match(/\bas[:\s]+[“"'‘].*$/)?.[0] || '')),
    };
    const ref = new RegExp(`\\b(north|south|east|west)\\s+of\\s+${NAME}`);
    const hr = ref.exec(head); if (hr) { ctx.dir = hr[1]; ctx.cross = clean(hr[2]); }
    // A part can hold two stretches with different signs: "...as "P15..." and between the points 25.5 metres
    // and 31.5 metres north of Queens Lane, as "2P 8am-8pm"". Split those, sharing the cross street.
    const pieces = (parts.length > 1 ? parts.slice(1) : [head]).flatMap((p) => {
      const subs = p.split(/(?:,\s*|\s)and\s+(?:also\s+)?(?=between\b)/i);
      if (subs.length < 2 || subs.filter((x) => /\bas\b[^"“']*["“']/.test(x)).length < 2) return [p];
      const shared = subs.map((x) => ref.exec(x)).filter(Boolean).pop();
      const lead = /^.*?(?:(?:northern|southern|eastern|western) side of [^,]+|(?:Northern|Southern|Eastern|Western) side)/i.exec(subs[0])?.[0] || '';
      return subs.map((x, i) => `${i && lead ? `${lead}, ` : ''}${ref.test(x) || !shared ? x : `${x} ${shared[0]}`}`);
    });
    for (const p of pieces) {
      if (/footpath|kerb extension|bollard|install signage for the car share|review the|liabilit/i.test(p) && !/\bas\b/i.test(p)) continue;
      const street = clean(new RegExp(`side of ${NAME}`).exec(p)?.[1] || new RegExp(`(?:^|\\s)in ${NAME}`).exec(p)?.[1] || ctx.street);
      const side = SIDE[/(northern|southern|eastern|western) side|^\(?[A-Z]?\)?\s*(Northern|Southern|Eastern|Western) side/i.exec(p)?.slice(1).find(Boolean)?.toLowerCase()] || ctx.side;
      const r = ref.exec(p);
      const dir = r?.[1] || ctx.dir, cross = r ? clean(r[2]) : ctx.cross;
      let signs = quotes(p);
      if (!signs.length) signs = ctx.signs;
      const unrestricted = /as unrestricted/i.test(p);
      const ranges = [...p.matchAll(/(\d+(?:\.\d+)?)\s*m(?:etres?|eters?)?\s+and\s+(?:the point\s+)?(\d+(?:\.\d+)?)\s*m(?:etres?|eters?)?\b/gi)].map((m) => [+m[1], +m[2]]);
      // "between Irving Street and the point 20.3 metres north of Irving Street"
      const fromCorner = new RegExp(`between ${NAME} and the point (\\d+(?:\\.\\d+)?)\\s*m(?:etres)?\\s+(north|south|east|west) of ${NAME}`, 'i').exec(p);
      let spans = ranges.map(([a, b]) => ({ x: cross, dir, a, b }));
      if (fromCorner) spans = [{ x: clean(fromCorner[4]), dir: fromCorner[3], a: 0, b: +fromCorner[2] }];
      if (!spans.length || !street || !side || !spans[0].x || !spans[0].dir) { skipped.noplace++; continue; }
      if (signs.some((s) => /TICKET|METER/i.test(s))) { skipped.ticket++; continue; }
      const text = signs.join('; ');
      const rules = unrestricted ? [] : readSign(signs.join(' ; ')).rules;
      if (!unrestricted && !rules.length) { skipped.nosign++; continue; }
      for (const s of spans) {
        if (s.b <= s.a || s.b - s.a > 400) continue;
        entries.push({ street, suburb, area, side: [side], a: { x: s.x, m: s.a, dir: s.dir }, b: { x: s.x, m: s.b, dir: s.dir }, rules, text: unrestricted ? 'Unrestricted' : text, src: 'cosdec', date: d.date, ref: d.id });
        made.push(d.id);
      }
    }
  }
  // Newer decisions replace older ones for the same stretch of kerb.
  const ymd = (s) => (s ? s.split('/').reverse().join('') : '0');
  entries.sort((p, q) => ymd(q.date).localeCompare(ymd(p.date)) || +q.ref - +p.ref);
  const kept = [];
  for (const e of entries) {
    const clash = kept.some((k) => k.street === e.street && k.side[0] === e.side[0] && k.a.x === e.a.x && k.a.dir === e.a.dir && Math.min(k.b.m, e.b.m) - Math.max(k.a.m, e.a.m) > 0.5 * (e.b.m - e.a.m));
    if (!clash) kept.push(e);
  }
  return { entries: kept, skipped, decisions: new Set(made).size };
}
