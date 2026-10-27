// Turns drivers' "Report a wrong sign" reports into GitHub issues, so they show up in the GitHub app.
// Reads the report: keys from the Streety server's KV store, opens one issue per report (photo saved on the
// `reports` branch and shown in the issue), then removes the report from KV. Test reports are just removed.
// Needs CLOUDFLARE_API_TOKEN (Workers KV Storage: Edit), GITHUB_TOKEN (issues + contents: write), GITHUB_REPOSITORY.
// CLOUDFLARE_ACCOUNT_ID is optional: the token's own account is used when it's empty.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const T = process.env.CLOUDFLARE_API_TOKEN, GH = process.env.GITHUB_TOKEN, REPO = process.env.GITHUB_REPOSITORY;
if (!T || !GH || !REPO) { console.log('missing tokens: nothing to do'); process.exit(0); }
const cf = async (path, opts = {}, raw = false) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...opts, headers: { authorization: `Bearer ${T}`, ...(opts.headers || {}) } });
  if (raw) { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.text(); }
  const j = await r.json();
  if (!j.success) throw new Error(`${path}: ${JSON.stringify(j.errors)}`);
  return j;
};
const gh = async (path, body) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${GH}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!r.ok && r.status !== 422) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

const A = process.env.CLOUDFLARE_ACCOUNT_ID || (await cf('/accounts')).result[0]?.id;
const ns = (await cf(`/accounts/${A}/storage/kv/namespaces?per_page=100`)).result.find((n) => n.title === 'streety-SNAPS');
if (!ns) { console.log('no KV store yet'); process.exit(0); }
const KV = `/accounts/${A}/storage/kv/namespaces/${ns.id}`;
const keys = (await cf(`${KV}/keys?prefix=report:&limit=1000`)).result.map((k) => k.name);
console.log(`${keys.length} new report(s)`);
if (!keys.length) process.exit(0);

await gh('/labels', { name: 'report', color: 'd93f0b', description: 'A driver reported a wrong sign or price in the app' });
const KIND = { sign: 'The sign says something else', nopark: "You can't park here", price: 'The price is wrong', name: 'Wrong street name', other: 'Something else', closed: 'Closed or gone', full: 'Always full' };
const CITY = { syd: 'Sydney', mel: 'Melbourne', bne: 'Brisbane', per: 'Perth' };

// The reports branch keeps every report (JSON + photo), so nothing is lost when it leaves KV.
const dir = 'reports-branch';
if (!existsSync(dir)) {
  const url = `https://x-access-token:${GH}@github.com/${REPO}.git`;
  try { execSync(`git clone -q --depth 1 -b reports ${url} ${dir}`, { stdio: 'pipe' }); }
  catch { mkdirSync(dir); execSync(`git init -q -b reports && git remote add origin ${url}`, { cwd: dir }); }
}
mkdirSync(`${dir}/photos`, { recursive: true }); mkdirSync(`${dir}/json`, { recursive: true });

let made = 0;
for (const key of keys) {
  const id = key.slice(7);
  const r = JSON.parse(await cf(`${KV}/values/${encodeURIComponent(key)}`, {}, true));
  if (r.kind === 'test') { await cf(`${KV}/values/${encodeURIComponent(key)}`, { method: 'DELETE' }); console.log(`test report ${id} removed`); continue; }
  const { photo, ...rest } = r;
  let img = '';
  if (photo?.startsWith('data:image/jpeg;base64,')) {
    writeFileSync(`${dir}/photos/${id}.jpg`, Buffer.from(photo.split(',')[1], 'base64'));
    img = `\n\n![Photo](https://github.com/${REPO}/blob/reports/photos/${id}.jpg?raw=true)`;
  }
  writeFileSync(`${dir}/json/${id}.json`, JSON.stringify(rest, null, 1));
  const [lng, lat] = r.at;
  const where = r.title || (r.target === 'carpark' ? 'a car park' : 'a street');
  const body = [
    `**${KIND[r.kind] || r.kind}** at **${where}** (${CITY[r.city] || r.city || '?'}, ${r.target === 'carpark' ? 'car park' : 'street'})`,
    r.note ? `> ${String(r.note).replace(/\n/g, '\n> ')}` : '_No note._',
    `[Open on the map](https://www.google.com/maps?q=${lat},${lng}) · [Street View](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng})`,
    `Sent ${r.time || r.received}. Map data then: ${r.published || 'unknown'}. Item id: \`${r.id ?? '?'}\`. Report \`${id}\`.`,
  ].join('\n\n') + img;
  // Push the photo first, so the issue's picture works straight away.
  execSync(`git add -A && git -c user.name=streety-bot -c user.email=streety@users.noreply.github.com commit -qm "Report ${id}" && git push -q origin reports`, { cwd: dir, stdio: 'pipe' });
  const issue = await gh('/issues', { title: `${KIND[r.kind] || r.kind}: ${where}`.slice(0, 120), body, labels: ['report'] });
  console.log(`issue #${issue.number} for ${id}`);
  await cf(`${KV}/values/${encodeURIComponent(key)}`, { method: 'DELETE' });
  made++;
}
console.log(`${made} issue(s) opened`);
