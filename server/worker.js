// Kerb's small server (a Cloudflare Worker, free tier). Two jobs, both optional:
//   POST /read  { image: dataURL }        -> { text }   Claude reads the parking sign in the photo.
//   POST /snap  { street, at, rules, ... } -> { ok }     stores a driver's sign reading for everyone.
//   GET  /snaps                            -> [ ...readings ]   the nightly build pulls these in.
// Setup (one time): npx wrangler deploy; npx wrangler secret put ANTHROPIC_API_KEY; create a KV namespace
// called SNAPS and bind it in wrangler.toml. Then set the GitHub secrets VITE_SIGN_READ_URL=<worker>/read and
// VITE_SNAP_SHARE_URL=<worker>/snap so the app uses them.
const MODEL = 'claude-sonnet-5-5';
const ORIGIN = 'https://guykalo.github.io';
const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...cors } });

const PROMPT = `This is a photo of one or more Australian (NSW) parking signs on a pole. Write out exactly what the parking signs say, top to bottom, one sign per line, in this style:
2P 8AM-6PM MON-FRI PERMIT HOLDERS EXCEPTED AREA 22
NO STOPPING
1/2P TICKET 8:30AM-6PM MON-FRI 8:30AM-12:30PM SAT
Include arrows as "<-" or "->" at the end of a line if shown. Only write what is printed on the signs. If you can't read part of it, write "?" there. If there is no parking sign, reply NONE.`;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/read' && req.method === 'POST') {
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
    if (url.pathname === '/snaps' && req.method === 'GET') {
      const list = await env.SNAPS.list({ limit: 1000 });
      const rows = await Promise.all(list.keys.map((k) => env.SNAPS.get(k.name, 'json')));
      return json(rows.filter(Boolean));
    }
    return json({ error: 'not found' }, 404);
  },
};
