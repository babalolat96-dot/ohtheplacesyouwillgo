// Your own saved places, kept server side so the phone and the laptop see the
// same bank. Netlify Blobs: no database to run, no signup, free at this size.
// Writing requires a passphrase, because the site itself is public.

const { getStore } = require('@netlify/blobs');

const KEY = 'saved-v1';

function store() {
  // Netlify injects the credentials for us at run time
  return getStore({ name: 'otp-bank', consistency: 'strong' });
}

function passOk(given) {
  const want = (process.env.OTP_PASS || '').trim();
  if (!want) return { ok: false, why: 'no_pass_set' };
  if (String(given || '').trim() !== want) return { ok: false, why: 'bad_pass' };
  return { ok: true };
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);

// keep only the fields the map needs, in the shape the rest of the bank uses
function clean(p) {
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const lat = num(Number(p.lat)), lng = num(Number(p.lng));
  if (lat === null || lng === null) return null;
  if (!(lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) return null;
  const name = String(p.n || p.name || '').trim().slice(0, 120);
  if (!name) return null;
  const KINDS = ['eat', 'drink', 'coffee', 'outdoors', 'culture', 'shop'];
  const c = KINDS.includes(p.c) ? p.c : (KINDS.includes(p.kind) ? p.kind : 'eat');
  const BANDS = ['Free', '£', '££', '£££', '££££'];
  return {
    n: name,
    aka: [],
    t: String(p.t || p.type || c).slice(0, 40),
    c,
    lat, lng,
    area: p.area ? String(p.area).slice(0, 60) : null,
    hood: p.hood ? String(p.hood).slice(0, 60) : (p.area ? String(p.area).slice(0, 60) : null),
    boro: null,
    reg: p.reg ? String(p.reg).slice(0, 20) : null,
    addr: p.addr ? String(p.addr).slice(0, 200) : (p.address ? String(p.address).slice(0, 200) : null),
    pc: p.pc ? String(p.pc).slice(0, 10) : null,
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 6).map(t => String(t).slice(0, 30)) : [],
    price: null,
    conf: 'mine',
    fixed: true,
    orders: [],
    prices: [],
    vibes: [],
    m: [{ t: 'Saved by you', u: null, b: String(p.note || p.why || '').slice(0, 400) }],
    src: 'mine',
    cui: p.cui ? String(p.cui).slice(0, 40) : null,
    band: BANDS.includes(p.band) ? p.band : null,
    rat: p.rat != null ? String(p.rat).slice(0, 4) : (p.rating != null ? String(p.rating).slice(0, 4) : null),
    gid: p.gid ? String(p.gid).slice(0, 200) : (p.id ? String(p.id).slice(0, 200) : null),
    savedAt: Date.now(),
  };
}

async function readAll(s) {
  try {
    const v = await s.get(KEY, { type: 'json' });
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const action = String(body.action || 'list');

  let s;
  try { s = store(); }
  catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_store', detail: String(e) }) };
  }

  try {
    // reading is open: it is your own list on your own site
    if (action === 'list') {
      const places = await readAll(s);
      return { statusCode: 200, headers, body: JSON.stringify({ places, count: places.length }) };
    }

    const auth = passOk(body.pass);
    if (!auth.ok)
      return { statusCode: 200, headers, body: JSON.stringify({ error: auth.why }) };

    if (action === 'add') {
      const rec = clean(body.place || {});
      if (!rec) return { statusCode: 200, headers, body: JSON.stringify({ error: 'bad_place' }) };
      const places = await readAll(s);
      const key = slug(rec.n);
      const at = places.findIndex(x => slug(x.n) === key);
      if (at >= 0) places[at] = Object.assign({}, places[at], rec);
      else places.push(rec);
      await s.setJSON(KEY, places);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved: rec, count: places.length, replaced: at >= 0 }) };
    }

    if (action === 'remove') {
      const key = slug(body.name);
      const places = await readAll(s);
      const left = places.filter(x => slug(x.n) !== key);
      await s.setJSON(KEY, left);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, removed: places.length - left.length, count: left.length }) };
    }

    if (action === 'check')
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

    return { statusCode: 200, headers, body: JSON.stringify({ error: 'unknown_action' }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'exception', detail: String(e) }) };
  }
};
