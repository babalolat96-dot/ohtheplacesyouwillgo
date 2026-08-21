// One small photo per venue, by NAME, cached forever: the card face of a place.
//
// GET /api/thumb?n=<venue name>&a=<area hint>
//
// First ask for a venue costs Google money (place lookup + photo media), so the
// image BYTES are stored in Blobs and every ask after that is free. A venue
// with no findable photo is remembered too ("miss" marker), so it never bills
// twice. The API key never reaches the browser — bytes come from here.
//
// Netlify Functions v2 — Blobs credentials are only injected into v2 functions.

import { getStore } from '@netlify/blobs';

const G_KEYS = ['GOOGLE_PLACES_KEY', 'GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY', 'PLACES_KEY'];
const googleKey = () => {
  for (const n of G_KEYS) { const v = process.env[n]; if (v && v.trim()) return v.trim(); }
  for (const v of Object.values(process.env))
    if (/^AIza[0-9A-Za-z_-]{20,}$/.test(String(v || '').trim())) return String(v).trim();
  return null;
};

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
const WIDTH = 480;                       // card thumbs and detail strips both read fine at this
const MISS_DAYS = 30;                    // a photo-less place gets re-checked monthly

const nope = (why) => new Response(why, { status: 404,
  headers: { 'Cache-Control': 'public, max-age=86400' } });

async function fetchJson(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal });
        return r.ok ? await r.json() : null; }
  catch (e) { return null; }
  finally { clearTimeout(t); }
}

export default async (req) => {
  const u = new URL(req.url);
  const name = (u.searchParams.get('n') || '').trim().slice(0, 120);
  const area = (u.searchParams.get('a') || '').trim().slice(0, 60);
  if (name.length < 2) return nope('bad name');
  const sl = slug(name);
  if (!sl) return nope('bad name');

  let store;
  try { store = getStore({ name: 'otp-bank', consistency: 'strong' }); }
  catch (e) { return nope('no store'); }

  // the fast path: bytes already banked
  try {
    const hit = await store.getWithMetadata('thumb:' + sl, { type: 'arrayBuffer' });
    if (hit && hit.data && hit.data.byteLength > 100) {
      return new Response(hit.data, { status: 200, headers: {
        'Content-Type': (hit.metadata && hit.metadata.ct) || 'image/jpeg',
        'Cache-Control': 'public, max-age=604800, immutable' } });
    }
  } catch (e) {}

  // a known miss stays a miss until it goes stale
  try {
    const m = await store.get('thumbmiss:' + sl, { type: 'json' });
    if (m && m.at && Date.now() - m.at < MISS_DAYS * 864e5) return nope('no photo');
  } catch (e) {}

  const key = googleKey();
  if (!key) return nope('no key');

  // the enrichment already knows most venues' Google ids — reuse, don't re-search
  let gid = null;
  try {
    const enr = await store.get('enrich-v1', { type: 'json' });
    if (enr && enr[sl] && enr[sl].gid) gid = enr[sl].gid;
  } catch (e) {}
  if (!gid) {
    const s = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
                 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({ textQuery: [name, area, 'London'].filter(Boolean).join(', '),
        maxResultCount: 1, languageCode: 'en-GB', regionCode: 'GB' }),
    }, 3000);
    gid = s && s.places && s.places[0] && s.places[0].id || null;
  }

  const remember = async () => {
    try { await store.setJSON('thumbmiss:' + sl, { at: Date.now() }); } catch (e) {}
    return nope('no photo');
  };
  if (!gid) return remember();

  const d = await fetchJson(`https://places.googleapis.com/v1/places/${gid}`, {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'photos' },
  }, 3500);
  const ref = d && d.photos && d.photos[0] && d.photos[0].name || null;
  if (!ref) return remember();

  const media = await fetchJson('https://places.googleapis.com/v1/' + ref +
    '/media?maxWidthPx=' + WIDTH + '&skipHttpRedirect=true&key=' + encodeURIComponent(key), {}, 3500);
  if (!media || !media.photoUri) return remember();

  try {
    const ir = await fetch(media.photoUri, { signal: AbortSignal.timeout(5000) });
    if (!ir.ok) return remember();
    const ct = ir.headers.get('content-type') || 'image/jpeg';
    const buf = await ir.arrayBuffer();
    if (buf.byteLength < 100) return remember();
    try { await store.set('thumb:' + sl, buf, { metadata: { ct } }); } catch (e) {}
    return new Response(buf, { status: 200, headers: {
      'Content-Type': ct, 'Cache-Control': 'public, max-age=604800, immutable' } });
  } catch (e) { return nope('fetch failed'); }
};
