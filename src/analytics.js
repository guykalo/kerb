// Visitor counter: Cloudflare Web Analytics (free, no cookies, no personal data).
// Token for guykalo.github.io (can be overridden by the VITE_CF_BEACON_TOKEN GitHub secret).
// It isn't a secret: Cloudflare puts it in every page that uses it.
const TOKEN = import.meta.env.VITE_CF_BEACON_TOKEN || 'cbe8c4a4347d484b98ce488515903f7c';

export function initAnalytics() {
  if (!TOKEN || location.hostname === 'localhost') return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: TOKEN }));
  document.head.appendChild(s);
}
