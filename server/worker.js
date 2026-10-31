// Streety's small server (a Cloudflare Worker, free tier). All jobs optional:
//   POST /read  { image: dataURL }        -> { text }   Claude reads the parking sign in the photo.
//   POST /snap  { street, at, rules, ... } -> { ok }     stores a driver's sign reading for everyone.
//   GET  /snaps                            -> [ ...readings ]   the nightly build pulls these in.
//   POST /report { kind, street, at, note, photo? } -> { ok }  a driver reports a wrong sign or price.
//   GET  /reports  (header x-admin-key)    -> [ ...reports ]  for fixing the map.
// Setup (one time): npx wrangler deploy; npx wrangler secret put ANTHROPIC_API_KEY; create a KV namespace
// called SNAPS and bind it in wrangler.toml. Then set the GitHub secrets VITE_SIGN_READ_URL=<worker>/read and
// VITE_SNAP_SHARE_URL=<worker>/snap so the app uses them.
const MODEL = 'claude-sonnet-5-5';
const ORIGINS = ['https://getstreety.com.au', 'https://www.getstreety.com.au', 'https://streety.pages.dev', 'https://guykalo.github.io'];
let cors = {};
const corsFor = (req) => { const o = req.headers.get('origin') || ''; return { 'access-control-allow-origin': ORIGINS.includes(o) || o.endsWith('.streety.pages.dev') ? o : ORIGINS[0], 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' }; };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...cors } });

const PROMPT = `This is a photo of one or more Australian (NSW) parking signs on a pole. Write out exactly what the parking signs say, top to bottom, one sign per line, in this style:
2P 8AM-6PM MON-FRI PERMIT HOLDERS EXCEPTED AREA 22
NO STOPPING
1/2P TICKET 8:30AM-6PM MON-FRI 8:30AM-12:30PM SAT
1/4P FREE TICKET 2P 8AM-6PM <-
Signs often print AM and PM small beside the hour ("8 AM - 6 PM"): write them as one time range like 8AM-6PM.
A small box saying "1/4P FREE" (first 15 minutes free) belongs to the sign it is on: start that sign's line with 1/4P FREE.
Write permit wording in full, including the area letter or number (PERMIT HOLDERS EXCEPTED AREA G).
Include arrows as "<-" or "->" at the end of a line if shown. Only write what is printed on the signs. If you can't read part of it, write "?" there. If there is no parking sign, reply NONE.`;

export default {
  async fetch(req, env) {
    cors = corsFor(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/read' && req.method === 'POST') {
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'reader off' }, 503);
      // Only the app's own pages, and a daily cap so a stranger can't run up the reading bill.
      const o = req.headers.get('origin') || '';
      if (!ORIGINS.includes(o) && !o.endsWith('.streety.pages.dev')) return json({ error: 'not allowed' }, 403);
      const ck = `read:${new Date().toISOString().slice(0, 10)}`, used = +((await env.SNAPS.get(ck)) || 0);
      if (used >= (+env.READ_CAP || 300)) return json({ error: 'reader busy today' }, 429);
      await env.SNAPS.put(ck, String(used + 1), { expirationTtl: 172800 });
      const { image } = await req.json();
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image || '');
      if (!m || m[2].length > 6_000_000) return json({ error: 'Send a JPEG or PNG under 4 MB' }, 400);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.MODEL || MODEL, max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: PROMPT }] }] }),
      });
      if (!r.ok) return json({ error: `reader ${r.status}` }, 502);
      const out = await r.json();
      const text = out.content?.map((c) => c.text || '').join('\n').trim() || '';
      return json({ text: text === 'NONE' ? '' : text });
    }
    if (url.pathname === '/snap' && req.method === 'POST') {
      const s = await req.json();
      if (!s?.rules?.length || !Array.isArray(s.at) || s.at.length !== 2) return json({ error: 'missing rules or position' }, 400);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const { thumb, ...rest } = s;
      await env.SNAPS.put(id, JSON.stringify({ ...rest, received: new Date().toISOString() }), { metadata: { at: s.at } });
      return json({ ok: true, id });
    }
    if (url.pathname === '/report' && req.method === 'POST') {
      const r = await req.json();
      if (!r?.kind || !Array.isArray(r.at) || r.at.length !== 2) return json({ error: 'missing kind or position' }, 400);
      if (r.photo && (!/^data:image\/jpeg;base64,/.test(r.photo) || r.photo.length > 3_000_000)) return json({ error: 'photo must be a JPEG under 2 MB' }, 400);
      if (String(r.note || '').length > 2000) return json({ error: 'note too long' }, 400);
      const id = `report:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      await env.SNAPS.put(id, JSON.stringify({ ...r, received: new Date().toISOString() }), { metadata: { at: r.at, kind: r.kind } });
      return json({ ok: true, id });
    }
    if (url.pathname === '/reports' && req.method === 'GET') {
      if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) return json({ error: 'not allowed' }, 403);
      const list = await env.SNAPS.list({ prefix: 'report:', limit: 1000 });
      const rows = await Promise.all(list.keys.map((k) => env.SNAPS.get(k.name, 'json')));
      return json(rows.filter(Boolean));
    }
    if (url.pathname === '/snaps' && req.method === 'GET') {
      const list = { keys: (await env.SNAPS.list({ limit: 1000 })).keys.filter((k) => !/^(report|read):/.test(k.name)) };
      const rows = await Promise.all(list.keys.map((k) => env.SNAPS.get(k.name, 'json')));
      return json(rows.filter(Boolean));
    }
    return json({ error: 'not found' }, 404);
  },
};
