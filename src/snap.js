// Snap the sign: photograph a parking sign, read it, check it, get an answer, and pin it to the kerb.
// Reading happens on the phone (Tesseract OCR, loaded only when first used). If VITE_SIGN_READ_URL is set,
// a server reads the photo instead (Claude vision, see server/worker.js) and the phone is the fallback.
// Readings are saved on this phone and drawn on its map; with VITE_SNAP_SHARE_URL set they're also sent
// to a shared store so other drivers get them after the next nightly build.
import { readSign, describePanel, splitByArrow } from '../scripts/lib/sign-words.mjs';
import { costFor, plainNow, stateAt, fmtTime, money, DAYS, DAYS_LONG } from './rules.js';

const READ_URL = import.meta.env.VITE_SIGN_READ_URL || '';
const SHARE_URL = import.meta.env.VITE_SNAP_SHARE_URL || '';
const KEY = 'kerb-snaps';
const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

export const loadSnaps = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const saveSnaps = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; } };

let C = null; // context from main.js
export function initSnap(ctx) {
  C = ctx;
  const btn = document.getElementById('snapBtn'), input = document.getElementById('snapFile');
  if (!btn || !input) return;
  let where = null, fromKerb = null;
  btn.addEventListener('click', () => {
    where = null;
    fromKerb = C.selected?.() ?? null; // snapped from a kerb's page: that's the kerb
    // Ask for the position while the camera is open, so it's ready when the photo comes back.
    navigator.geolocation?.getCurrentPosition((p) => { where = { at: [p.coords.longitude, p.coords.latitude], acc: p.coords.accuracy }; }, () => {}, { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
    input.value = '';
    input.click();
  });
  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) openSnap(f, () => where, fromKerb); });
}

/* ---------- reading ---------- */
function loadImage(file) {
  return new Promise((ok, bad) => { const img = new Image(); img.onload = () => ok(img); img.onerror = bad; img.src = URL.createObjectURL(file); });
}
function toCanvas(img, max, grey) {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0, cv.width, cv.height);
  if (grey) {
    const d = g.getImageData(0, 0, cv.width, cv.height), px = d.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < px.length; i += 4) { const v = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]; px[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const s = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) { const v = (px[i] - lo) * s; px[i] = px[i + 1] = px[i + 2] = v; }
    g.putImageData(d, 0, 0);
  }
  return cv;
}
let tess = null;
function tesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return tess || (tess = new Promise((ok, bad) => { const s = document.createElement('script'); s.src = TESS; s.onload = () => ok(window.Tesseract); s.onerror = () => { tess = null; bad(new Error('Could not load the sign reader')); }; document.head.appendChild(s); }));
}
async function readPhoto(img, progress) {
  if (READ_URL) {
    try {
      progress('Reading the sign…');
      const r = await fetch(READ_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: toCanvas(img, 1600).toDataURL('image/jpeg', 0.85) }) });
      if (r.ok) { const j = await r.json(); if (j.text) return { text: j.text, by: 'ai' }; }
    } catch { /* fall back to the phone */ }
  }
  progress('Getting the sign reader ready (first time only)…');
  const T = await tesseract();
  let pass = 0;
  const worker = await T.createWorker('eng', 1, { logger: (m) => { if (m.status === 'recognizing text') progress(`Reading the sign… ${Math.round(((pass + m.progress) / 4) * 100)}%`); } });
  try {
    // A photo of a pole is mostly shopfronts, sky and wood. Read just the white sign plates, in black and
    // white at a size the reader likes, then the whole photo as a fallback; keep the reading that makes most sense.
    const plates = signCrop(img);
    const tries = [];
    for (const [cv, psm] of [[plates, '6'], [plates, '11'], [toCanvas(img, 1800, true), '3'], [toCanvas(img, 1800, true), '11']]) {
      if (!cv) { pass++; continue; }
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(cv);
      const text = fixOcr(data.text);
      tries.push({ text, score: score(text) });
      pass++;
      if (tries[tries.length - 1].score >= 6) break; // a header and a time: good enough
    }
    tries.sort((a, b) => b.score - a.score);
    return { text: tries[0]?.text || '', by: 'phone' };
  } finally { worker.terminate(); }
}
// How much of a parking sign this reading looks like: headers, times and days that parse.
function score(text) {
  const { panels } = readSign(text);
  return panels.reduce((s, p) => s + 2 + p.times.filter(([f, t]) => !(f === 0 && t === 24)).length * 2 + (p.ticket ? 1 : 0) + (p.permit ? 1 : 0), 0);
}
// Slips the phone reader makes on NSW signs, where AM/PM are printed small and low beside the hour:
// "8AM-6PM" comes back as "8.7 6..." and "6PM-10PM" as "6.710.,". Only used on the phone's reading.
export function fixOcr(raw) {
  return String(raw || '')
    .replace(/\b(\d{1,2})\s?[.,·]{1,3}\s?[7~—–-]\s?(\d{1,2})\s?[.,·]{1,3}/g, (m, a, b) => (+a <= 12 && +b <= 12 ? `${a}-${b}PM ` : m));
}
// Find the white sign plates (bright, colourless, filled rectangles) and return just them, in black and white.
function signCrop(img) {
  const S = 6, big = toCanvas(img, 1800, false), W = Math.floor(big.width / S), H = Math.floor(big.height / S);
  if (W < 20 || H < 20) return null;
  const sm = document.createElement('canvas'); sm.width = W; sm.height = H;
  const sg = sm.getContext('2d'); sg.drawImage(big, 0, 0, W, H);
  const px = sg.getImageData(0, 0, W, H).data, n = W * H, mn = new Uint8Array(n), sat = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; mn[i] = Math.min(r, g, b); sat[i] = Math.max(r, g, b) - mn[i]; }
  const sorted = Array.from(mn).sort((a, b) => a - b), cut = Math.max(150, sorted[Math.floor(n * 0.92)] - 25);
  const on = new Uint8Array(n); for (let i = 0; i < n; i++) on[i] = mn[i] > cut && sat[i] < 45 ? 1 : 0;
  const seen = new Uint8Array(n), boxes = [];
  for (let s = 0; s < n; s++) {
    if (!on[s] || seen[s]) continue;
    const q = [s]; seen[s] = 1; let x0 = W, y0 = H, x1 = 0, y1 = 0, cnt = 0;
    while (q.length) {
      const c = q.pop(), x = c % W, y = (c - x) / W; cnt++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const d of [c - 1, c + 1, c - W, c + W]) if (d >= 0 && d < n && on[d] && !seen[d] && Math.abs((d % W) - x) <= 1) { seen[d] = 1; q.push(d); }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (cnt > n * 0.004 && cnt / (w * h) > 0.45 && w / h > 0.25 && w / h < 4) boxes.push([x0, y0, x1 + 1, y1 + 1]);
  }
  if (!boxes.length) return null;
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b[0])) - 1) * S, y0 = Math.max(0, Math.min(...boxes.map((b) => b[1])) - 1) * S;
  const x1 = Math.min(W, Math.max(...boxes.map((b) => b[2])) + 1) * S, y1 = Math.min(H, Math.max(...boxes.map((b) => b[3])) + 1) * S;
  // About 700 px wide: big sign letters read better smaller. Then black and white (Otsu's threshold).
  const k = 700 / (x1 - x0), cv = document.createElement('canvas'); cv.width = 700; cv.height = Math.round((y1 - y0) * k);
  const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(big, x0, y0, x1 - x0, y1 - y0, 0, 0, cv.width, cv.height);
  const d = g.getImageData(0, 0, cv.width, cv.height), p = d.data, hist = new Array(256).fill(0);
  for (let i = 0; i < p.length; i += 4) { const v = Math.min(p[i], p[i + 1], p[i + 2]); p[i] = v; hist[v]++; }
  let total = p.length / 4, sum = 0, sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += i * hist[i]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; t = i; } }
  for (let i = 0; i < p.length; i += 4) { const v = p[i] > t ? 255 : 0; p[i] = p[i + 1] = p[i + 2] = v; }
  g.putImageData(d, 0, 0);
  return cv;
}

/* ---------- placing it on a kerb ---------- */
function nearestKerbs(at) {
  const K = C.kerbs();
  if (!K || !at) return null;
  let best = null, bd = 30;
  for (const f of K.features) { const d = C.distM(C.mids.get(f.properties.id), at); if (d < bd) { bd = d; best = f; } }
  if (!best) return null;
  const p = best.properties, ids = [];
  for (const f of K.features) if (f.properties.s === p.s && (f.properties.sd || '') === (p.sd || '') && f.properties.b === p.b && C.distM(C.mids.get(f.properties.id), C.mids.get(p.id)) < 35) ids.push(f.properties.id);
  return { ids, street: p.s, side: p.sd || p.b || '', d: Math.round(bd) };
}
// No kerb drawn here yet: take the street from the base map and draw a 40 m kerb on the side you're standing.
async function kerbFromRoad(at, onlyName) {
  const { map } = C;
  if (C.distM(map.getCenter().toArray(), at) > 60 || map.getZoom() < 16.5) { map.jumpTo({ center: at, zoom: 17.2 }); await new Promise((r) => { map.once('idle', r); setTimeout(r, 2500); }); }
  const pt = map.project(at);
  const names = map.queryRenderedFeatures([[pt.x - 80, pt.y - 80], [pt.x + 80, pt.y + 80]]).filter((f) => f.sourceLayer === 'transportation_name' && f.properties.name);
  // A street the driver picked by name: use that street's own line, even if another road is nearer.
  const feats = onlyName ? names.filter((f) => f.properties.name === onlyName && f.geometry.type.includes('LineString'))
    : map.queryRenderedFeatures([[pt.x - 60, pt.y - 60], [pt.x + 60, pt.y + 60]]).filter((f) => f.sourceLayer === 'transportation' && f.geometry.type.includes('LineString') && !/path|track|rail|ferry|bridleway/.test(f.properties.class || ''));
  const k = Math.cos((at[1] * Math.PI) / 180) * 111320, m = (a) => [(a[0] - at[0]) * k, (a[1] - at[1]) * 110540], back = (x, y) => [at[0] + x / k, at[1] + y / 110540];
  let best = null;
  for (const f of feats) {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const L of lines) for (let i = 1; i < L.length; i++) {
      const [ax, ay] = m(L[i - 1]), [bx, by] = m(L[i]), dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      if (!l2) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)), px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
      if (!best || d < best.d) best = { d, px, py, ux: dx / Math.sqrt(l2), uy: dy / Math.sqrt(l2), f };
    }
  }
  if (!best || best.d > (onlyName ? 60 : 25)) return null;
  // Which side of the street is the phone on? Offset the kerb that way.
  const side = Math.sign(best.ux * -best.py + best.uy * best.px) || 1;
  const nx = -best.uy * side, ny = best.ux * side, off = 4;
  const line = [-20, 0, 20].map((s) => back(best.px + best.ux * s + nx * off, best.py + best.uy * s + ny * off));
  const near = names.map((f) => ({ f, d: Math.hypot(...m(f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0])) })).sort((a, b) => a.d - b.d)[0];
  const street = onlyName || best.f.properties.name || near?.f.properties.name || 'This street';
  const compass = Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'East side' : 'West side') : ny > 0 ? 'North side' : 'South side';
  return { line, street, side: compass };
}
// Other streets close to where the photo was taken. Near a corner the phone's position often lands on the
// cross street, so these are offered as one-tap switches. Kerbs Streety knows first, then the base map's names.
function streetsNear(at, current) {
  const out = new Map();
  const K = C.kerbs();
  if (K && at) for (const f of K.features) {
    const p = f.properties;
    if (!p.s || p.s === current || p.id >= 9000000) continue;
    const d = C.distM(C.mids.get(p.id), at);
    if (d < 60 && (!out.has(p.s) || d < out.get(p.s).d)) out.set(p.s, { d, id: p.id });
  }
  try {
    const pt = C.map.project(at), c = C.map.getCanvas();
    if (pt.x > 0 && pt.y > 0 && pt.x < c.clientWidth && pt.y < c.clientHeight) {
      for (const f of C.map.queryRenderedFeatures([[pt.x - 70, pt.y - 70], [pt.x + 70, pt.y + 70]])) {
        const s = f.sourceLayer === 'transportation_name' && f.properties.name;
        if (s && s !== current && !out.has(s)) out.set(s, { d: 99, id: null });
      }
    }
  } catch { /* map not ready */ }
  return [...out].sort((a, b) => a[1].d - b[1].d).slice(0, 3).map(([street, v]) => ({ street, ...v }));
}

/* ---------- the panel ---------- */
const LIMITS = [['0.25', '15 min (¼P)'], ['0.5', '30 min (½P)'], ['1', '1P'], ['2', '2P'], ['3', '3P'], ['4', '4P'], ['6', '6P'], ['8', '8P'], ['nopark', 'No parking'], ['nostop', 'No stopping'], ['zone:Loading Zone', 'Loading zone'], ['zone:Bus Zone', 'Bus zone']];
const hours = Array.from({ length: 49 }, (_, i) => i / 2);
const hOpt = (sel) => hours.map((h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${h === 24 ? 'midnight' : fmtTime(h)}</option>`).join('');
function kindValue(p) { return p.kind === 'limit' ? String(p.hours) : p.kind === 'zone' ? `zone:${p.head.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())}` : p.kind === 'works' ? 'nopark' : p.kind; }

async function openSnap(file, getWhere, fromKerb) {
  const el = document.createElement('div');
  el.className = 'snap';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Read a parking sign');
  el.innerHTML = `<div class="snap-card"><div class="snap-top"><b>Snap the sign</b><button type="button" class="snap-x" aria-label="Close"><i class="ph ph-x"></i></button></div>
    <div class="snap-body"><img class="snap-img" alt="Your photo of the sign"><div class="snap-verdict" hidden></div><div class="snap-where" hidden></div><p class="snap-status">Opening the photo…</p><div class="snap-panels"></div></div>
    <div class="snap-actions">${SHARE_URL ? `<label class="snap-share"><input type="checkbox"${SHARE_ON() ? ' checked' : ''}> Share with other drivers (just the sign wording, no photo)</label>` : ''}<button type="button" class="snap-save" disabled>Save to this kerb</button></div></div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const close = () => el.remove();
  $('.snap-x').onclick = close;
  el.addEventListener('click', (e) => { if (e.target === el) close(); });

  let img;
  try { img = await loadImage(file); } catch { $('.snap-status').textContent = "That photo couldn't be opened. Try again."; return; }
  $('.snap-img').src = img.src;
  let panels = [], read = null, leftOff = [];
  try {
    read = await readPhoto(img, (m) => ($('.snap-status').textContent = m));
    ({ keep: panels, other: leftOff } = splitByArrow(readSign(read.text).panels));
  } catch (e) { $('.snap-status').textContent = `${e.message}. You can still type in what the sign says.`; }
  $('.snap-status').innerHTML = panels.length
    ? `Here's what Streety read${read?.by === 'ai' ? '' : ' (on your phone)'}. <b>Check it against the sign</b> and fix anything that's wrong.${leftOff.length ? ` The ${leftOff.map((p) => describePanel(p).split(' ').slice(0, 2).join(' ')).join(' and ')} sign points the other way, so it's left off this kerb.` : ''}`
    : "Streety couldn't read this one. Set what the sign says below. Tip: get closer so the sign fills most of the photo.";
  if (!panels.length) panels = [{ kind: 'limit', hours: 2, head: '2P', times: [[8, 18, [1, 2, 3, 4, 5]]] }];

  const render = () => {
    $('.snap-panels').innerHTML = panels.map((p, i) => `<div class="sp" data-i="${i}">
      <div class="sp-row"><select class="sp-kind" aria-label="Sign type">${LIMITS.map(([v, t]) => `<option value="${v}"${v === kindValue(p) ? ' selected' : ''}>${t}</option>`).join('')}</select>
        ${p.kind === 'limit' ? `<label class="sp-chk"><input type="checkbox" class="sp-ticket"${p.ticket ? ' checked' : ''}> Ticket</label>` : ''}
        ${p.kind === 'limit' && p.ticket ? `<label class="sp-chk"><input type="checkbox" class="sp-q"${p.free15 ? ' checked' : ''}> ¼P free</label>` : ''}
        ${panels.length > 1 ? '<button type="button" class="sp-del" aria-label="Remove this part"><i class="ph ph-trash"></i></button>' : ''}</div>
      ${p.times.map(([f, t, d], j) => `<div class="sp-time" data-j="${j}"><select class="sp-f" aria-label="From">${hOpt(f)}</select><span>to</span><select class="sp-t" aria-label="To">${hOpt(t)}</select>
        <div class="sp-days">${[1, 2, 3, 4, 5, 6, 0].map((x) => `<button type="button" data-d="${x}" aria-pressed="${d.includes(x)}">${DAYS[x][0]}${DAYS[x][1]}</button>`).join('')}</div>
        ${p.times.length > 1 ? '<button type="button" class="sp-tdel" aria-label="Remove this time"><i class="ph ph-x"></i></button>' : ''}</div>`).join('')}
      <div class="sp-row"><button type="button" class="sp-addt">+ Another time</button>
        ${p.kind === 'limit' ? `<label class="sp-chk"><input type="checkbox" class="sp-permit"${p.permit ? ' checked' : ''}> Permit holders excepted</label>${p.permit ? `<input class="sp-area" placeholder="Area" value="${p.permit !== 'yes' ? p.permit : ''}" aria-label="Permit area">` : ''}` : ''}</div>
      <p class="sp-say">${describePanel(p)}</p></div>`).join('') + '<button type="button" class="sp-add">+ Another sign on this pole</button>';
    $('.snap-panels').querySelectorAll('.sp').forEach((box) => {
      const p = panels[+box.dataset.i];
      box.querySelector('.sp-kind').onchange = (e) => { const v = e.target.value; if (/^\d|^0/.test(v)) { p.kind = 'limit'; p.hours = +v; } else if (v.startsWith('zone:')) { p.kind = 'zone'; p.head = v.slice(5).toUpperCase(); } else p.kind = v; render(); };
      box.querySelector('.sp-ticket')?.addEventListener('change', (e) => { p.ticket = e.target.checked; render(); });
      box.querySelector('.sp-q')?.addEventListener('change', (e) => { p.free15 = e.target.checked; render(); });
      box.querySelector('.sp-permit')?.addEventListener('change', (e) => { p.permit = e.target.checked ? 'yes' : undefined; render(); });
      box.querySelector('.sp-area')?.addEventListener('change', (e) => { p.permit = e.target.value.trim().toUpperCase() || 'yes'; render(); });
      box.querySelector('.sp-del')?.addEventListener('click', () => { panels.splice(+box.dataset.i, 1); render(); });
      box.querySelector('.sp-addt').onclick = () => { p.times.push([8, 18, [1, 2, 3, 4, 5]]); render(); };
      box.querySelectorAll('.sp-time').forEach((row) => {
        const tm = p.times[+row.dataset.j];
        row.querySelector('.sp-f').onchange = (e) => { tm[0] = +e.target.value; render(); };
        row.querySelector('.sp-t').onchange = (e) => { tm[1] = +e.target.value; render(); };
        row.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { const d = +b.dataset.d; tm[2] = tm[2].includes(d) ? tm[2].filter((x) => x !== d) : [...tm[2], d].sort(); render(); }));
        row.querySelector('.sp-tdel')?.addEventListener('click', () => { p.times.splice(+row.dataset.j, 1); render(); });
      });
    });
    $('.sp-add').onclick = () => { panels.push({ kind: 'limit', hours: 2, head: '2P', times: [[8, 18, [1, 2, 3, 4, 5]]] }); render(); };
    verdict();
  };
  const rulesNow = () => {
    const out = [];
    for (const p of panels) for (const t of p.times) if (t[2].length) out.push(...readSign(`${p.kind === 'limit' ? `${p.hours}P` : p.kind === 'nostop' ? 'NO STOPPING' : p.kind === 'nopark' ? 'NO PARKING' : p.head} ${fmtSpan(t)}${p.ticket ? ' TICKET' : ''}${p.permit ? ` PERMIT HOLDERS EXCEPTED${p.permit !== 'yes' ? ` AREA ${p.permit}` : ''}` : ''}`).rules);
    return out;
  };
  // "¼P FREE" on a ticket sign: the first 15 minutes are free with a ticket (the app's q flag on a rule set).
  const qNow = () => (panels.some((p) => p.kind === 'limit' && p.ticket && p.free15) ? 1 : 0);
  const verdict = () => {
    const rules = rulesNow(), S = C.S, set = [{ rules, q: qNow(), text: '' }], props = { k: 0 };
    const v = $('.snap-verdict'); v.hidden = false;
    if (!rules.length) { v.innerHTML = ''; return; }
    const c = costFor(props, set, S.day, S.hour, S.stay);
    const st = stateAt(props, set, S.day, S.hour);
    const now = st.kind === 'free' ? `The sign doesn't apply on ${DAYS_LONG[S.day]} at ${fmtTime(S.hour)}, so there's no limit right now.${st.until < 24 ? ` It starts again at ${fmtTime(st.until)}.` : ''}` : plainNow(props, set, S.day, S.hour);
    v.className = `snap-verdict ${c.ok ? 'yes' : 'no'}`;
    v.innerHTML = `<b>${c.ok ? `Yes, you can park here for ${C.stayWords()}` : `No, not for ${C.stayWords()}`}</b><span>${c.ok ? `${c.cost > 0 ? `About ${money(c.cost)}. ` : c.unknownRate ? 'Pay at the meter. ' : ''}${now}` : `${c.why}.`}</span><small>${C.when()}. The sign on the street always wins.</small>`;
  };
  render();
  $('.snap-save').disabled = false;

  // Where is it?
  const whereBox = $('.snap-where');
  let place = null, alts = [];
  const showWhere = () => {
    whereBox.hidden = false;
    alts = place?.at ? streetsNear(place.at, place.street) : [];
    whereBox.innerHTML = place
      ? `<i class="ph ph-map-pin" aria-hidden="true"></i><span>On <b>${place.street}</b>${place.side ? `, ${place.side.toLowerCase()}` : ''}${place.d != null ? `, ${place.d} m from you` : ''}</span><button type="button" class="snap-pick">Change</button>
        ${alts.length ? `<div class="snap-alts"><span>Not this street?</span>${alts.map((a, i) => `<button type="button" class="snap-alt" data-a="${i}">${a.street}</button>`).join('')}</div>` : ''}`
      : `<i class="ph ph-map-pin" aria-hidden="true"></i><span>Streety couldn't tell where you are.</span><button type="button" class="snap-pick">Pick the kerb</button>`;
    whereBox.querySelector('.snap-pick').onclick = pick;
    whereBox.querySelectorAll('.snap-alt').forEach((b) => (b.onclick = async () => {
      const a = alts[+b.dataset.a], at = place.at;
      let next = a.id != null ? nearestKerbs(C.mids.get(a.id)) : null;
      if (next && next.street !== a.street) next = null;
      if (!next) { const k = await kerbFromRoad(at, a.street); if (k) next = { ...k, ids: [] }; }
      if (!next) { C.toast(`Tap the kerb on ${a.street}`); pick(); return; }
      place = { ...next, d: null, at };
      showWhere();
    }));
  };
  const locate = async () => {
    if (fromKerb != null && C.mids.get(fromKerb)) { place = nearestKerbs(C.mids.get(fromKerb)); if (place) { place.d = null; place.at = C.mids.get(fromKerb); } showWhere(); return; }
    for (let i = 0; i < 24 && !getWhere(); i++) await new Promise((r) => setTimeout(r, 250));
    const w = getWhere();
    if (!w) { showWhere(); return; }
    place = nearestKerbs(w.at);
    if (!place) { const k = await kerbFromRoad(w.at); if (k) place = { ...k, ids: [], d: null }; }
    if (place) place.at = w.at;
    showWhere();
  };
  // Hide the card, let them tap the kerb on the map, then come back.
  const pick = () => {
    el.hidden = true;
    C.toast('Tap the kerb this sign is on');
    C.pickKerb(async (lngLat, id) => {
      el.hidden = false;
      if (id != null) { const f = C.byId.get(id); place = nearestKerbs(C.mids.get(id)) || { ids: [id], street: f.properties.s, side: f.properties.sd || '' }; place.d = null; place.at = C.mids.get(id); }
      else { const k = await kerbFromRoad(lngLat); place = k ? { ...k, ids: [], d: null, at: lngLat } : place; }
      showWhere();
    });
  };
  locate();

  $('.snap-save').onclick = async () => {
    if (!place) { pick(); return; }
    const rules = rulesNow();
    if (!rules.length) return;
    // Kerbs numbered 9,000,000 and up only exist on this phone (drawn from earlier photos), so a shared reading
    // can't point at them: save that kerb's line instead.
    let ids = (place.ids || []).filter((x) => x < 9000000), line = place.line || null;
    const tmp = (place.ids || []).find((x) => x >= 9000000);
    if (tmp != null && !ids.length && !line) line = C.byId.get(tmp)?.geometry.coordinates || null;
    // Ids change with each night's build: keep the kerb's line too, so the reading finds its kerb again.
    if (ids.length && !line) line = C.byId.get(ids[0])?.geometry.coordinates || null;
    const snap = { id: `s${Date.now().toString(36)}`, date: new Date().toISOString().slice(0, 10), street: place.street, side: place.side || '', at: place.at, ids, line, rules, q: qNow(), text: panels.map(describePanel).join('; '), read: read?.text?.slice(0, 400) || '', by: read?.by || 'typed', thumb: toCanvas(img, 360).toDataURL('image/jpeg', 0.7) };
    const list = loadSnaps().filter((s) => !(s.ids.length && s.ids.some((x) => snap.ids.includes(x))));
    list.unshift(snap);
    if (!saveSnaps(list.slice(0, 60))) saveSnaps(list.slice(0, 20).map((s) => ({ ...s, thumb: '' })));
    C.applySnaps();
    let shared = false;
    const shareBox = document.querySelector('.snap-share input');
    if (shareBox) { try { localStorage.setItem('streety-share', shareBox.checked ? '1' : '0'); } catch { /* private mode */ } }
    if (SHARE_URL && (!shareBox || shareBox.checked)) { try { const { thumb, ...data } = snap; data.city = C.city; shared = (await fetch(SHARE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })).ok; } catch { /* stays on the phone */ } }
    close();
    C.toast(shared ? 'Saved. Thanks, other drivers will see it after tonight\'s update.' : 'Saved on this phone. The kerb now shows what the sign says.');
    const id = snap.ids[0] ?? C.snapKerbId(snap.id);
    if (id != null) C.select(id, true);
  };
}
const fmtSpan = ([f, t, d]) => {
  const hm = (h) => { const hh = Math.floor(h) % 24, mm = Math.round((h % 1) * 60); return `${hh % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${hh < 12 ? 'AM' : 'PM'}`; };
  const dn = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return `${f === 0 && (t === 24 || t === 0) ? '' : `${hm(f)}-${hm(t)}`} ${d.length === 7 ? '' : d.map((x) => dn[x]).join(' & ')}`.trim();
};

// Turn saved photos into kerbs on this phone's map: existing kerbs get the photo's rules, and kerbs drawn
// from the base map are added as new pieces. Returns the ids of the new pieces by snap id.
// Sign readings other drivers shared (from Streety's server), applied under this phone's own readings.
let SHARED = [];
export function setSharedSnaps(list) { SHARED = Array.isArray(list) ? list.filter((s) => s && Array.isArray(s.rules) && s.rules.length) : []; }
export const SHARE_ON = () => { try { return localStorage.getItem('streety-share') !== '0'; } catch { return true; } };
export function snapsToKerbs(K, RULES, byId, mids) {
  const made = new Map();
  let next = 9000000;
  // Undo the last pass first, so saving again never stacks copies.
  if (RULES.base == null) RULES.base = RULES.length; else RULES.length = RULES.base;
  K.features = K.features.filter((f) => { if (f.properties.id >= 9000000) { byId.delete(f.properties.id); mids.delete(f.properties.id); return false; } return true; });
  for (const f of K.features) if (f.properties.snap) { f.properties.k = f.properties.k0; delete f.properties.snap; }
  const mine = loadSnaps();
  const all = [...SHARED.filter((x) => !mine.some((m) => m.ids?.some((i) => x.ids?.includes(i)))).map((x) => ({ ...x, shared: true })), ...mine.slice().reverse()];
  for (const s of all) {
    const k = RULES.push({ rules: s.rules, q: s.q ? 1 : 0, text: s.text, src: s.shared ? `A Streety driver's reading of the sign, ${s.date}` : `Your sign photo, ${s.date}` }) - 1;
    const take = (f) => { if (!f.properties.snap) f.properties.k0 = f.properties.k; f.properties.k = k; f.properties.snap = 1; };
    // Kerb ids are renumbered by each night's build, so an id only counts if it's still the same street.
    // Ids from 9,000,000 are kerbs drawn on someone's phone and mean nothing here (older readings saved them).
    const ids = (s.ids || []).filter((x) => x < 9000000 && byId.get(x) && (!s.street || byId.get(x).properties.s === s.street));
    if (ids.length) { for (const id of ids) take(byId.get(id)); continue; }
    // A line that sits on a kerb Streety already has (same street, same ends): give that kerb the sign.
    const ref = s.line ? [(s.line[0][0] + s.line[s.line.length - 1][0]) / 2, (s.line[0][1] + s.line[s.line.length - 1][1]) / 2] : s.at;
    const same = ref && s.street ? nearestOn(K, mids, ref, s.street, s.line ? 8 : 40) : null;
    if (same) { take(same); continue; }
    if (!s.line) continue;
    const id = next++;
    const f = { type: 'Feature', properties: { id, s: s.street, b: '', sd: s.side, k, z: 2, pa: '', f15: 0, n: 0, snap: 1 }, geometry: { type: 'LineString', coordinates: s.line } };
    K.features.push(f); byId.set(id, f); mids.set(id, s.line[1]); made.set(s.id, id);
  }
  return made;
}
function nearestOn(K, mids, at, street, max) {
  const k = Math.cos((at[1] * Math.PI) / 180) * 111320;
  let best = null, bd = max;
  for (const f of K.features) {
    const p = f.properties;
    if (p.id >= 9000000 || p.s !== street) continue;
    const m = mids.get(p.id);
    if (!m) continue;
    const d = Math.hypot((m[0] - at[0]) * k, (m[1] - at[1]) * 110540);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

/* ---------- Snap the price board (car parks) ---------- */
// Prices photographed at the entrance. Reads "0-1 HR $15 / 1-2 HRS $25 / ALL DAY $60" style boards into casual
// bands the app already prices with; the driver checks every number before saving.
const BOARD_KEY = 'kerb-boards';
export const loadBoards = () => { try { return JSON.parse(localStorage.getItem(BOARD_KEY) || '{}'); } catch { return {}; } };
export function readBoard(raw) {
  const t = ` ${String(raw || '').toUpperCase().replace(/[‐-―−~]/g, '-').replace(/\bO(?=\d)/g, '0').replace(/(\d)\s*[.,]\s*(\d\d)\b/g, '$1.$2')} `;
  const bands = [];
  for (const m of t.matchAll(/(?:(\d+(?:\.\d+)?)\s*(?:-|TO)\s*)?(\d+(?:\.\d+)?)\s*(MINS?|MINUTES|HRS?|HOURS?)\b[^$\d]{0,14}\$\s?(\d+(?:\.\d\d)?)/g)) {
    const upTo = +m[2] / (/^MIN/.test(m[3]) ? 60 : 1), price = +m[4];
    if (upTo > 0 && upTo <= 24 && price < 400) bands.push([upTo, price]);
  }
  const day = /(?:ALL ?DAY|DAILY(?: MAX(?:IMUM)?)?|MAX(?:IMUM)? (?:DAILY|PER DAY)|24 ?HRS?)\D{0,14}\$\s?(\d+(?:\.\d\d)?)/.exec(t);
  if (day) bands.push([24, +day[1]]);
  const early = /EARLY ?BIRD\D{0,30}\$\s?(\d+(?:\.\d\d)?)/.exec(t);
  const night = /(?:NIGHT|EVENING)\D{0,30}\$\s?(\d+(?:\.\d\d)?)/.exec(t);
  const uniq = [...new Map(bands.sort((a, b) => a[0] - b[0]).map((b) => [b[0], b])).values()];
  return { bands: uniq, early: early ? +early[1] : null, night: night ? +night[1] : null };
}
export function initBoard(ctx) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment'); input.hidden = true; document.body.appendChild(input);
  let cp = null;
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-snapboard]'); if (!b) return; cp = ctx.carPark(b.dataset.snapboard); if (!cp) return; input.value = ''; input.click(); });
  input.addEventListener('change', () => { const f = input.files?.[0]; if (f && cp) openBoard(f, cp, ctx); });
}
async function openBoard(file, cp, ctx) {
  const el = document.createElement('div'); el.className = 'snap'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Read a price board');
  el.innerHTML = `<div class="snap-card"><div class="snap-top"><b>Prices at ${cp.name}</b><button type="button" class="snap-x" aria-label="Close"><i class="ph ph-x"></i></button></div>
    <div class="snap-body"><img class="snap-img" alt="Your photo of the price board"><p class="snap-status">Opening the photo…</p><div class="snap-panels"></div></div>
    <div class="snap-actions"><button type="button" class="snap-save" disabled>Save these prices</button></div></div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s); const close = () => el.remove();
  $('.snap-x').onclick = close; el.addEventListener('click', (e) => { if (e.target === el) close(); });
  let img; try { img = await loadImage(file); } catch { $('.snap-status').textContent = "That photo couldn't be opened."; return; }
  $('.snap-img').src = img.src;
  let got = { bands: [], early: null, night: null }, text = '';
  try { const r = await readPhoto(img, (m) => ($('.snap-status').textContent = m.replace('sign', 'price board'))); text = r.text; got = readBoard(text); } catch (e) { $('.snap-status').textContent = e.message; }
  $('.snap-status').innerHTML = got.bands.length ? 'Here\'s what Streety read. <b>Check each price against the board</b> and fix anything wrong.' : "Streety couldn't read the prices. Type them in from the board below.";
  const rows = got.bands.length ? got.bands : [[1, 0], [2, 0], [3, 0], [24, 0]];
  const render = () => {
    $('.snap-panels').innerHTML = `<div class="sp">${rows.map(([h, p], i) => `<div class="sp-row" data-i="${i}"><span>Up to</span><select class="b-h" aria-label="Hours">${[0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 24].map((x) => `<option value="${x}"${x === h ? ' selected' : ''}>${x === 24 ? 'all day' : x < 1 ? '30 min' : `${x} hr${x > 1 ? 's' : ''}`}</option>`).join('')}</select><span>$</span><input class="b-p" inputmode="decimal" value="${p || ''}" aria-label="Price" style="width:80px"><button type="button" class="sp-tdel" aria-label="Remove"><i class="ph ph-x"></i></button></div>`).join('')}
      <button type="button" class="sp-addt">+ Another price</button>
      <div class="sp-row"><label class="sp-chk">Early bird $<input class="b-e" inputmode="decimal" value="${got.early ?? ''}" style="width:70px"></label><label class="sp-chk">Night $<input class="b-n" inputmode="decimal" value="${got.night ?? ''}" style="width:70px"></label></div></div>`;
    el.querySelectorAll('[data-i]').forEach((r) => {
      const i = +r.dataset.i;
      r.querySelector('.b-h').onchange = (e) => { rows[i][0] = +e.target.value; };
      r.querySelector('.b-p').oninput = (e) => { rows[i][1] = +e.target.value || 0; };
      r.querySelector('.sp-tdel').onclick = () => { rows.splice(i, 1); render(); };
    });
    $('.sp-addt').onclick = () => { rows.push([rows.length ? Math.min(24, rows[rows.length - 1][0] + 1) : 1, 0]); render(); };
  };
  render();
  $('.snap-save').disabled = false;
  $('.snap-save').onclick = () => {
    const bands = rows.filter(([, p]) => p > 0).sort((a, b) => a[0] - b[0]);
    if (!bands.length) { $('.snap-status').textContent = 'Add at least one price.'; return; }
    const ALL = [0, 1, 2, 3, 4, 5, 6];
    const rates = [{ kind: 'casual', days: ALL, bands }];
    const e = +el.querySelector('.b-e').value, n = +el.querySelector('.b-n').value;
    if (e > 0) rates.push({ kind: 'flat', label: 'Early bird', days: [1, 2, 3, 4, 5], enter: [6, 9.5], exitAfter: 15, price: e });
    if (n > 0) rates.push({ kind: 'flat', label: 'Night', days: ALL, enter: [17, 23.99], exitBy: 6, price: n });
    const boards = loadBoards();
    boards[cp.id] = { rates, date: new Date().toISOString().slice(0, 10), read: text.slice(0, 400) };
    try { localStorage.setItem(BOARD_KEY, JSON.stringify(boards)); } catch { /* storage full */ }
    if (SHARE_URL) fetch(SHARE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'board', carpark: cp.id, at: cp.at, rates, date: boards[cp.id].date }) }).catch(() => {});
    close(); ctx.applyBoards(); ctx.toast('Saved. This car park now shows the prices from your photo.');
  };
}
