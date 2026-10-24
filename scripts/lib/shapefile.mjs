// Minimal zip + shapefile (shp/dbf) reader and MGA zone 56 to lat/lon conversion.
// Works in Node 18+ and browsers (uses DecompressionStream). No dependencies.

export async function unzip(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = b.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a zip file');
  const n = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < n; i++) {
    const comp = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
    const lo = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(b.slice(off + 46, off + 46 + nl));
    const lnl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true);
    let data = b.slice(lo + 30 + lnl + lel, lo + 30 + lnl + lel + csize);
    if (comp === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    files[name] = data;
    off += 46 + nl + el + cl;
  }
  return files;
}

export function readDbf(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nrec = dv.getUint32(4, true), hl = dv.getUint16(8, true), rl = dv.getUint16(10, true);
  const fields = [];
  for (let p = 32; b[p] !== 0x0d; p += 32) fields.push({ name: new TextDecoder().decode(b.slice(p, p + 11)).replace(/\0.*$/, ''), len: b[p + 16] });
  const td = new TextDecoder('latin1');
  const rows = [];
  for (let i = 0; i < nrec; i++) {
    let p = hl + i * rl + 1;
    const r = {};
    for (const f of fields) { r[f.name] = td.decode(b.slice(p, p + f.len)).trim(); p += f.len; }
    rows.push(r);
  }
  return rows;
}

// Returns an array of geometries: points [x,y], or multi-part lines [[[x,y],...], ...].
export function readShp(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let p = 100;
  while (p + 8 <= b.length) {
    const len = dv.getInt32(p + 4, false) * 2;
    const rp = p + 8;
    const type = dv.getInt32(rp, true);
    if (type === 0) out.push(null);
    else if (type === 1 || type === 11 || type === 21) out.push([dv.getFloat64(rp + 4, true), dv.getFloat64(rp + 12, true)]);
    else if (type === 8 || type === 18 || type === 28) {
      const np = dv.getInt32(rp + 36, true);
      out.push([dv.getFloat64(rp + 40, true), dv.getFloat64(rp + 48, true)]);
      void np;
    } else if (type === 3 || type === 13 || type === 23 || type === 5 || type === 15 || type === 25) {
      const nParts = dv.getInt32(rp + 36, true), nPts = dv.getInt32(rp + 40, true);
      const parts = []; for (let i = 0; i < nParts; i++) parts.push(dv.getInt32(rp + 44 + i * 4, true));
      const ptBase = rp + 44 + nParts * 4;
      const lines = [];
      for (let i = 0; i < nParts; i++) {
        const a = parts[i], z = i + 1 < nParts ? parts[i + 1] : nPts;
        const line = [];
        for (let k = a; k < z; k++) line.push([dv.getFloat64(ptBase + k * 16, true), dv.getFloat64(ptBase + k * 16 + 8, true)]);
        lines.push(line);
      }
      out.push(lines);
    } else out.push(null);
    p = rp + len;
  }
  return out;
}

// GDA94 / MGA zone 56 (EPSG:28356) easting/northing to [lon, lat]. Accurate to well under a metre.
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9996, LON0 = 153 * Math.PI / 180, FE = 500000, FN = 10000000;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
export function mga56ToLonLat([x, y]) {
  const M = (y - FN) / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const N1 = A / Math.sqrt(1 - E2 * s * s), R1 = (A * (1 - E2)) / (1 - E2 * s * s) ** 1.5;
  const C1 = EP2 * c * c, T1 = t * t, D = (x - FE) / (N1 * K0);
  const lat = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = LON0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
