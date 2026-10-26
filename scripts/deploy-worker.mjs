// Deploys Streety's small server (server/worker.js) to Cloudflare Workers and prints its address for the app build.
// Needs CLOUDFLARE_API_TOKEN (Workers Scripts: Edit, Workers KV Storage: Edit) and CLOUDFLARE_ACCOUNT_ID.
// Makes the KV store and the workers.dev subdomain if they don't exist yet. Writes url=<https://...> to
// $GITHUB_OUTPUT when run in GitHub Actions.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const T = process.env.CLOUDFLARE_API_TOKEN, A = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!T || !A) { console.log('no Cloudflare token or account: skipping the server'); process.exit(0); }
const api = async (path, opts = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}${path}`, { ...opts, headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`${path}: ${JSON.stringify(j.errors || r.status)}`);
  return j.result;
};

// 1. A workers.dev subdomain (one per account).
let sub;
try { sub = (await api('/workers/subdomain')).subdomain; } catch { /* not registered yet */ }
if (!sub) {
  for (const name of ['getstreety', 'streety-app', `streety-${A.slice(0, 6)}`]) {
    try { sub = (await api('/workers/subdomain', { method: 'PUT', body: JSON.stringify({ subdomain: name }) })).subdomain; break; } catch (e) { console.log(`subdomain ${name}: ${e.message}`); }
  }
}
if (!sub) throw new Error('could not get a workers.dev subdomain');

// 2. The KV store for shared sign readings and reports.
const TITLE = 'streety-SNAPS';
const spaces = await api('/storage/kv/namespaces?per_page=100');
let ns = spaces.find((n) => n.title === TITLE);
if (!ns) ns = await api('/storage/kv/namespaces', { method: 'POST', body: JSON.stringify({ title: TITLE }) });

// 3. Deploy with that store bound.
const toml = (await readFile('server/wrangler.toml', 'utf8')).replace(/id = ".*"/, `id = "${ns.id}"`);
await writeFile('server/wrangler.deploy.toml', toml);
execSync('npx --yes wrangler@4 deploy --config server/wrangler.deploy.toml', { stdio: 'inherit', env: process.env });

// 4. Make sure the worker answers on workers.dev.
try { await api('/workers/scripts/streety/subdomain', { method: 'POST', body: JSON.stringify({ enabled: true }) }); } catch (e) { console.log(`enable workers.dev: ${e.message}`); }
const url = `https://streety.${sub}.workers.dev`;
console.log(`server: ${url}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\n`);
