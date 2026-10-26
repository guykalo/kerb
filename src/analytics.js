// Visitor counter: Cloudflare Web Analytics (free, no cookies, no personal data).
// The token comes from the VITE_CF_BEACON_TOKEN GitHub secret at build time; with no token, nothing loads.
// It isn't a secret: Cloudflare puts it in every page that uses it.
const TOKEN = import.meta.env.VITE_CF_BEACON_TOKEN || '';

export function initAnalytics() {
  if (!TOKEN || location.hostname === 'localhost') return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: TOKEN }));
  document.head.appendChild(s);
}
