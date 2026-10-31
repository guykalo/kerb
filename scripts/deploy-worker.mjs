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
try { execSync('npx --yes wrangler@4 deploy --config server/wrangler.deploy.toml', { stdio: 'inherit', env: process.env }); }
catch {
  // The Workers AI binding (free sign reader) can be refused on some accounts: deploy without it rather than not at all.
  console.log('deploy with Workers AI failed: deploying without the AI sign reader');
  await writeFile('server/wrangler.deploy.toml', toml.replace(/\[ai\]\s*\nbinding = "AI"\s*\n/, ''));
  execSync('npx --yes wrangler@4 deploy --config server/wrangler.deploy.toml', { stdio: 'inherit', env: process.env });
}

// 4. Make sure the worker answers on workers.dev.
try { await api('/workers/scripts/streety/subdomain', { method: 'POST', body: JSON.stringify({ enabled: true }) }); } catch (e) { console.log(`enable workers.dev: ${e.message}`); }
const url = `https://streety.${sub}.workers.dev`;
console.log(`server: ${url}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\n`);

// 5. The AI sign reader (POST /read) needs an Anthropic API key on the worker. From the repo secret
//    ANTHROPIC_API_KEY when it's set; the app only switches the reader on when the key is there.
const K = process.env.ANTHROPIC_API_KEY;
if (K) {
  try { await api('/workers/scripts/streety/secrets', { method: 'PUT', body: JSON.stringify({ name: 'ANTHROPIC_API_KEY', text: K, type: 'secret_text' }) }); }
  catch (e) { console.log(`reader key: ${e.message}`); }
}
// 6. Prove the reader works: send it a real sign photo (tests/fixtures) and check the answer parses as a sign.
//    The app only switches the AI reader on when this passes; otherwise it keeps reading on the phone.
let reader = false;
try {
  const { readSign, describePanel } = await import('./lib/sign-words.mjs');
  const img = `data:image/jpeg;base64,${(await readFile('tests/fixtures/sign-glebe-ticket.jpg')).toString('base64')}`;
  await new Promise((r) => setTimeout(r, 5000)); // a fresh deploy takes a moment to answer
  for (let i = 0; i < 3 && !reader; i++) {
    const r = await fetch(`${url}/read`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://getstreety.com.au' }, body: JSON.stringify({ image: img }) });
    const j = await r.json().catch(() => ({}));
    const got = readSign(j.text || '');
    console.log(`reader test ${i + 1}: ${r.status} by ${j.by || '-'}: ${JSON.stringify(j.text || j.tried || j.error || '').slice(0, 300)} => ${got.panels.map(describePanel).join('; ') || 'nothing parsed'}`);
    // The photo is "1/4P FREE TICKET 2P 8AM-6PM" over "1/4P FREE TICKET 4P 6PM-10PM", beside a Bus Zone.
    reader = got.panels.some((p) => p.kind === 'limit' && p.hours === 2) && got.panels.some((p) => p.kind === 'limit' && p.hours === 4);
    if (!reader) await new Promise((res) => setTimeout(res, 4000));
  }
} catch (e) { console.log(`reader test: ${e.message}`); }
console.log(`sign reader: ${reader ? 'on (AI reads sign photos; passed the Glebe test photo)' : 'off (the AI reader failed the test photo, so the app reads on the phone)'}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `reader=${reader ? 'yes' : ''}\n`);
