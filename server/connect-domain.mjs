// Connects getstreety.com.au to Streety on Cloudflare: the app (Pages project `streety`) on the root and www,
// and the server (Worker `streety`) on api.getstreety.com.au. Safe to run again: it only adds what's missing.
// Needs CLOUDFLARE_API_TOKEN with Pages Edit, Workers Scripts Edit, Zone DNS Edit, Zone Workers Routes Edit.
const T = process.env.CLOUDFLARE_API_TOKEN, DOMAIN = process.env.DOMAIN || 'getstreety.com.au', PROJECT = process.env.CF_PROJECT || 'streety';
const notes = [];
const say = (m) => { console.log(m); notes.push(m); };
const cf = async (path, opts = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...opts, headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const j = await r.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${r.status}` }] }));
  return j;
};
const err = (j) => (j.errors || []).map((e) => `${e.code || ''} ${e.message}`).join('; ');

const A = process.env.CLOUDFLARE_ACCOUNT_ID || (await cf('/accounts')).result?.[0]?.id;
const zone = (await cf(`/zones?name=${DOMAIN}`)).result?.[0];
if (!zone) { say(`zone ${DOMAIN} not found: add the domain in Cloudflare first`); }
else {
  say(`zone ${DOMAIN}: ${zone.status}${zone.status !== 'active' ? ` (nameservers: ${zone.name_servers.join(', ')})` : ''}`);
  const Z = `/zones/${zone.id}`;
  const recs = (await cf(`${Z}/dns_records?per_page=100`)).result || [];
  // 1. The app on the root and www.
  for (const name of [DOMAIN, `www.${DOMAIN}`]) {
    const have = recs.find((r) => r.name === name && ['CNAME', 'A', 'AAAA'].includes(r.type));
    if (have) say(`dns ${name}: already ${have.type} ${have.content}`);
    else { const j = await cf(`${Z}/dns_records`, { method: 'POST', body: { type: 'CNAME', name, content: `${PROJECT}.pages.dev`, proxied: true, ttl: 1 } }); say(`dns ${name}: ${j.success ? 'added' : 'failed ' + err(j)}`); }
    const d = await cf(`/accounts/${A}/pages/projects/${PROJECT}/domains`, { method: 'POST', body: { name } });
    say(`pages ${name}: ${d.success ? `added (${d.result?.status})` : /already/i.test(err(d)) ? 'already added' : 'failed ' + err(d)}`);
  }
  const list = await cf(`/accounts/${A}/pages/projects/${PROJECT}/domains`);
  for (const d of list.result || []) say(`pages domain ${d.name}: ${d.status}${d.verification_data?.error_message ? ' - ' + d.verification_data.error_message : ''}`);

  // 2. The server on api.<domain>: a Workers custom domain, or else a route plus a placeholder record.
  const api = `api.${DOMAIN}`;
  const cd = await cf(`/accounts/${A}/workers/domains`, { method: 'PUT', body: { hostname: api, service: 'streety', zone_id: zone.id, environment: 'production' } });
  if (cd.success) say(`server ${api}: custom domain set`);
  else {
    say(`server custom domain failed (${err(cd)}), using a route`);
    if (!recs.find((r) => r.name === api)) { const j = await cf(`${Z}/dns_records`, { method: 'POST', body: { type: 'AAAA', name: api, content: '100::', proxied: true, ttl: 1 } }); say(`dns ${api}: ${j.success ? 'added' : 'failed ' + err(j)}`); }
    const routes = (await cf(`${Z}/workers/routes`)).result || [];
    if (routes.find((r) => r.pattern === `${api}/*`)) say(`route ${api}/*: already there`);
    else { const j = await cf(`${Z}/workers/routes`, { method: 'POST', body: { pattern: `${api}/*`, script: 'streety' } }); say(`route ${api}/*: ${j.success ? 'added' : 'failed ' + err(j)}`); }
  }
  // 3. Always HTTPS.
  const h = await cf(`${Z}/settings/always_use_https`, { method: 'PATCH', body: { value: 'on' } });
  say(`always https: ${h.success ? 'on' : 'not set (' + err(h) + ')'}`);
}
if (process.env.GITHUB_STEP_SUMMARY) console.log(`::notice title=Domain::${notes.join(' | ')}`);
