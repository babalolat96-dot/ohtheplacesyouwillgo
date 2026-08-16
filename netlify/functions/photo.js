// Proxies one Google place photo so the API key never reaches the browser.
const KEY_NAMES = ['GOOGLE_PLACES_KEY', 'GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY', 'PLACES_KEY'];

function findKey() {
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  for (const v of Object.values(process.env)) {
    if (/^AIza[0-9A-Za-z_-]{20,}$/.test(String(v || '').trim())) return String(v).trim();
  }
  return null;
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const name = (p.name || '').toString();
  const w = Math.min(parseInt(p.w, 10) || 800, 1200);
  if (!/^places\/[^/]+\/photos\/[^/]+$/.test(name))
    return { statusCode: 400, body: 'bad photo reference' };

  const key = findKey();
  if (!key) return { statusCode: 404, body: 'no key' };

  try {
    const url = 'https://places.googleapis.com/v1/' + name +
      '/media?maxWidthPx=' + w + '&skipHttpRedirect=true&key=' + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) return { statusCode: 404, body: 'not available' };
    const d = await r.json();
    if (!d.photoUri) return { statusCode: 404, body: 'no uri' };
    // hand back a redirect to Google's own CDN: no image bytes pass through us
    return {
      statusCode: 302,
      headers: { Location: d.photoUri, 'Cache-Control': 'public, max-age=3600' },
      body: '',
    };
  } catch (e) {
    return { statusCode: 404, body: 'error' };
  }
};
