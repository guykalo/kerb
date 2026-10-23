import { fetchAll } from './lib/sources.mjs';
import { buildData } from './lib/build.mjs';
window.__kerbCheck = async () => {
  const raw = await fetchAll();
  const out = buildData(raw);
  window.__kerbOut = out;
  const json = (x) => JSON.stringify(x).length;
  return { meta: { ...out.meta, sources: undefined }, bytes: { kerbs: json(out.kerbs), rules: json(out.rules), meters: json(out.meters), carparks: json(out.carparks) } };
};
