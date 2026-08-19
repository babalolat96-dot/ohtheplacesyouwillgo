// Your own saved places, kept server side so the phone and the laptop see the
// same bank.
//
// This is a Netlify Functions *v2* handler (export default, Request/Response).
// That is not a style choice: Netlify only injects the Blobs credentials into
// v2 functions. The classic `exports.handler` form throws
// MissingBlobsEnvironmentError no matter what else is set up.

import { getStore } from '@netlify/blobs';

const KEY = 'saved-v1';
const FAVKEY = 'favs-v1';   // slugs of favourited places — the taste signal
const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function passOk(given) {
  const want = (process.env.OTP_PASS || '').trim();
  if (!want) return { ok: false, why: 'no_pass_set' };
  if (String(given || '').trim() !== want) return { ok: false, why: 'bad_pass' };
  return { ok: true };
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);

// keep only the fields the map needs, in the shape the rest of the bank uses
function clean(p) {
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (!(lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) return null;
  const name = String(p.n || p.name || '').trim().slice(0, 120);
  if (!name) return null;
  const KINDS = ['eat', 'drink', 'coffee', 'outdoors', 'culture', 'shop'];
  const c = KINDS.includes(p.c) ? p.c : (KINDS.includes(p.kind) ? p.kind : 'eat');
  const BANDS = ['Free', '£', '££', '£££', '££££'];
  const s = (v, n) => v ? String(v).slice(0, n) : null;
  // a place can arrive from an Instagram post: it keeps the post's words and
  // a link back, the same respect the Substack gets. Only instagram.com links.
  const isInsta = p.src === 'insta';
  const postUrl = isInsta && /^https:\/\/(www\.)?instagram\.com\//.test(String(p.mu || ''))
    ? String(p.mu).slice(0, 200) : null;
  return {
    n: name, aka: [], t: s(p.t || p.type || c, 40), c, lat, lng,
    area: s(p.area, 60), hood: s(p.hood || p.area, 60), boro: null, reg: s(p.reg, 20),
    addr: s(p.addr || p.address, 200), pc: s(p.pc || p.postcode, 10),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 6).map(t => String(t).slice(0, 30)) : [],
    price: null, conf: 'mine', fixed: true, orders: [], prices: [], vibes: [],
    m: [{ t: isInsta ? (s(p.mt, 80) || 'From Instagram') : 'Saved by you',
          u: postUrl, b: String(p.note || p.why || '').slice(0, 400) }],
    src: isInsta ? 'insta' : 'mine', cui: s(p.cui, 40),
    band: BANDS.includes(p.band) ? p.band : null,
    rat: p.rat != null ? String(p.rat).slice(0, 4) : (p.rating != null ? String(p.rating).slice(0, 4) : null),
    // the venue's own Instagram handle, when an import actually captured one —
    // this is what makes the card's Instagram button honest instead of a search
    ig: /^[a-z0-9._]{1,30}$/i.test(String(p.ig || '').replace(/^@/, ''))
      ? String(p.ig).replace(/^@/, '').toLowerCase() : null,
    gid: s(p.gid || p.id, 200),
    savedAt: Date.now(),
  };
}

async function readAll(store) {
  try {
    const v = await store.get(KEY, { type: 'json' });
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

export default async (req) => {
  if (req.method !== 'POST') return J({ error: 'POST only' }, 405);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const action = String(body.action || 'list');

  let store;
  try {
    store = getStore({ name: 'otp-bank', consistency: 'strong' });
  } catch (e) {
    return J({ error: 'no_store', detail: String(e && e.message || e) });
  }

  const readFavs = async () => {
    try {
      const v = await store.get(FAVKEY, { type: 'json' });
      return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 500) : [];
    } catch (e) { return []; }
  };

  try {
    // reading is open: it is your own list on your own site
    if (action === 'list') {
      const places = await readAll(store);
      const favs = await readFavs();
      return J({ places, count: places.length, favs });
    }

    const auth = passOk(body.pass);
    if (!auth.ok) return J({ error: auth.why });

    if (action === 'check') return J({ ok: true });

    if (action === 'add') {
      const rec = clean(body.place || {});
      if (!rec) return J({ error: 'bad_place' });
      const places = await readAll(store);
      const key = slug(rec.n);
      const at = places.findIndex(x => slug(x.n) === key);
      if (at >= 0) places[at] = { ...places[at], ...rec };
      else places.push(rec);
      await store.setJSON(KEY, places);
      return J({ ok: true, saved: rec, count: places.length, replaced: at >= 0 });
    }

    if (action === 'fav' || action === 'unfav') {
      const key = slug(body.name);
      if (!key) return J({ error: 'bad_name' });
      const favs = await readFavs();
      const has = favs.includes(key);
      const next = action === 'fav'
        ? (has ? favs : favs.concat(key))
        : favs.filter(x => x !== key);
      await store.setJSON(FAVKEY, next);
      return J({ ok: true, fav: action === 'fav', favs: next, count: next.length });
    }

    if (action === 'remove') {
      const key = slug(body.name);
      const places = await readAll(store);
      const left = places.filter(x => slug(x.n) !== key);
      await store.setJSON(KEY, left);
      return J({ ok: true, removed: places.length - left.length, count: left.length });
    }

    return J({ error: 'unknown_action' });
  } catch (e) {
    return J({ error: 'exception', detail: String(e && e.message || e) });
  }
};
