// Small geometry helpers (no dependencies). Coordinates are [lon, lat].
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function metersPerDeg(lat) {
  return { x: (Math.PI / 180) * R * Math.cos(rad(lat)), y: (Math.PI / 180) * R };
}

export function dist(a, b) {
  const k = metersPerDeg((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * k.x, (a[1] - b[1]) * k.y);
}

// Distance from point p to segment a-b, in metres.
export function distToSeg(p, a, b) {
  const k = metersPerDeg(p[1]);
  const ax = (a[0] - p[0]) * k.x, ay = (a[1] - p[1]) * k.y;
  const bx = (b[0] - p[0]) * k.x, by = (b[1] - p[1]) * k.y;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// Split a path into pieces no longer than maxLen metres.
export function densify(path, maxLen) {
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / maxLen));
    for (let j = 1; j <= n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  return out;
}

// Even-odd point-in-polygon over esri rings (outer rings and holes mixed).
export function inRings(p, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function bbox(coords) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of coords) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

export const round = (c, n = 5) => [+c[0].toFixed(n), +c[1].toFixed(n)];
