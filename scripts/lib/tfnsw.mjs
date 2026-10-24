// Transport for NSW Park&Ride car parks: location, size, and how full they usually get.
// The live count isn't useful from a nightly build (it's always empty at 2am), so instead we read the
// last week of history and keep an "usually this full" profile per weekday and hour.
// Needs TFNSW_API_KEY (a free key from opendata.transport.nsw.gov.au). Skipped when it's missing.
const API = 'https://api.transport.nsw.gov.au/v1/carpark';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => (globalThis.__log || console.log)(...a);

async function get(url, key, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { Authorization: `apikey ${key}`, Accept: 'application/json' } });
      if (r.status === 429) throw new Error('rate limited');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}\n  ${e.message}`);
      await sleep(1000 * 2 ** i);
    }
  }
}

// Sydney's calendar date `n` days ago, as YYYY-MM-DD.
const sydDate = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(Date.now() - n * 864e5));

// How many cars are in, from one reading. `total` is the facility count; fall back to the zones.
function carsIn(x) {
  const t = x.occupancy?.total;
  if (t != null && t !== '') return +t;
  return (x.zones || []).reduce((s, z) => s + (+(z.occupancy?.total ?? z.occupancy?.transients) || 0), 0);
}

// Runs fn over items with at most `n` in flight, keeping under the API's 5 requests a second.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); await sleep(250); }
  }));
  return out;
}

export async function fetchParkRide({ key = process.env.TFNSW_API_KEY, days = 8, limit = Infinity } = {}) {
  if (!key) throw new Error('TFNSW_API_KEY not set');
  const list = await get(API, key);
  const ids = Object.entries(list).filter(([, name]) => !/historical only/i.test(name)).map(([id]) => id).slice(0, limit);
  // A day's history runs from late morning the day before, so 8 dates (today back) cover every weekday hour.
  const dates = Array.from({ length: days }, (_, i) => sydDate(i));
  const facilities = await pool(ids, 3, async (id) => {
    const d = await get(`${API}?facility=${id}`, key);
    // sum[day][hour] and count[day][hour] of the share of spaces taken
    const sum = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const cnt = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const spots = +d.spots || 0;
    for (const date of dates) {
      let rows;
      try { rows = await get(`${API}/history?facility=${id}&eventdate=${date}`, key); } catch { continue; }
      for (const x of rows || []) {
        const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)/.exec(x.MessageDate || '');
        if (!m || !spots) continue;
        const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
        const share = Math.max(0, Math.min(1, carsIn(x) / spots));
        sum[dow][+m[4]] += share; cnt[dow][+m[4]] += 1;
      }
    }
    const occ = sum.map((row, di) => row.map((s, h) => (cnt[di][h] ? Math.round((100 * s) / cnt[di][h]) : null)));
    return {
      id, name: d.facility_name, spots,
      at: [+d.location?.longitude, +d.location?.latitude],
      address: [d.location?.address, d.location?.suburb].filter(Boolean).join(', '),
      occ, readings: cnt.flat().reduce((a, b) => a + b, 0),
    };
  });
  const ok = facilities.filter((f) => f.at.every(Number.isFinite));
  log(`  park&ride: ${ok.length} car parks, ${days} days of history`);
  return { dates, facilities: ok };
}

export function buildParkRide(raw) {
  return raw.facilities.map((f) => ({
    id: `pr-${f.id}`,
    name: f.name.replace(/^Park&Ride\s*-\s*/i, '') + ' Park&Ride',
    address: f.address,
    entry: '',
    operator: 'Transport for NSW',
    at: [+f.at[0].toFixed(6), +f.at[1].toFixed(6)],
    source: 'Transport for NSW',
    kind: 'parkride',
    spots: f.spots,
    occ: f.readings ? f.occ : null,
  }));
}
