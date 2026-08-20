// Importing Lamp — Angus Hyams' 796-place shared list — into the bank.
//
// The raw list is just names, ratings and a currency symbol: it does not say
// which CITY anything is in. So this resolves every entry against Google,
// decides London vs world from the coordinates that come back, and writes the
// London ones into the same server-side store the app already reads at boot.
// That is the point: no index.html rebuild, no second deploy for data.
//
// Two things make the resolving accurate rather than hopeful:
//  1. the currency symbol in the raw row (£/€/$/Rp/MAD) narrows the country;
//  2. saved lists cluster geographically — consecutive entries are usually the
//     same city — so an ambiguous name ("Tavern", "Love", "Garage") is biased
//     by the city its neighbours resolved to. The list order is preserved in
//     the data for exactly this reason.
//
// Runs on a schedule with a persisted cursor so it grinds through 700 entries
// a batch at a time and stops when done. Idempotent: re-running never
// duplicates, and a name Google cannot find is recorded as unresolved rather
// than retried forever.

import { getStore } from '@netlify/blobs';
import { LAMP } from './lamp-data.mjs';

export const config = { schedule: '*/5 * * * *' };

const LKEY = 'lamp-v1';       // resolved London places, bank-shaped
const WKEY = 'world-v1';      // everything outside London, parked for travel
const CKEY = 'lamp-cursor-v1';
const PER_RUN = 12;

const G_KEYS = ['GOOGLE_PLACES_KEY','GOOGLE_PLACES_API_KEY','GOOGLE_API_KEY','PLACES_KEY'];
const googleKey = () => {
  for (const n of G_KEYS) { const v = process.env[n]; if (v && v.trim()) return v.trim(); }
  return Object.values(process.env).map(v => String(v||'').trim())
    .find(v => /^AIza[0-9A-Za-z_-]{20,}$/.test(v)) || null;
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const slug = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,80);

const LONDON = { lo: [51.25, -0.56], hi: [51.72, 0.34] };
const inLondon = (lat, lng) =>
  lat > LONDON.lo[0] && lat < LONDON.hi[0] && lng > LONDON.lo[1] && lng < LONDON.hi[1];

// currency in the raw row → the country to search in
const CUR = [
  ['£', 'GB', 'London'], ['€', null, null], ['R$', 'BR', null], ['Rp', 'ID', 'Bali'],
  ['MAD', 'MA', 'Marrakech'], ['¥', 'JP', 'Tokyo'], ['₡', 'CR', null], ['$', 'US', null],
];
function curHint(p) {
  if (!p) return { region: null, city: null };
  for (const [sym, region, city] of CUR)
    if (p.includes(sym)) return { region, city };
  return { region: null, city: null };
}

// the Google category → the bank's six kinds
const KIND = [
  [/pub|bar|night_?club|wine|brewery|tavern|cocktail|jazz|piano/i, 'drink'],
  [/cafe|coffee|tea|bakery|brunch|breakfast/i, 'coffee'],
  [/park|garden|beach|lake|peninsula|hiking|plaza|swim/i, 'outdoors'],
  [/museum|gallery|theat|concert|cultural|historic|castle|live_?music|art/i, 'culture'],
  [/store|shop|market|mall|antique|vintage|butcher|fishmonger|clothing|collectib/i, 'shop'],
  [/restaurant|food|meal|diner|pizza|sushi|taco|ramen|dumpling|deli|grill|bbq|barbecue|seafood|steak|sandwich|dessert|ice_?cream/i, 'eat'],
];
function kindOf(row, g) {
  const s = [row.t, (g && ((g.primaryTypeDisplayName||{}).text || g.primaryType)), (g && (g.types||[]).join(' '))]
    .filter(Boolean).join(' ');
  for (const [re, k] of KIND) if (re.test(s)) return k;
  return 'eat';
}
const BANDS = { PRICE_LEVEL_FREE:'Free', PRICE_LEVEL_INEXPENSIVE:'£',
  PRICE_LEVEL_MODERATE:'££', PRICE_LEVEL_EXPENSIVE:'£££', PRICE_LEVEL_VERY_EXPENSIVE:'££££' };
// the raw row already carries a spend range; turn it into the bank's band
function bandFrom(p, level) {
  if (BANDS[level]) return BANDS[level];
  if (!p) return null;
  const m = String(p).match(/(\d[\d,]*)/);
  if (/100\+|100 ?\+/.test(p)) return '££££';
  if (!m) return null;
  const n = +m[1].replace(/,/g,'');
  if (!isFinite(n)) return null;
  if (/^£/.test(p)) return n <= 10 ? '£' : n <= 30 ? '££' : n <= 80 ? '£££' : '££££';
  return null;
}

async function gFetch(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal });
        return r.ok ? await r.json() : null; }
  catch (e) { return null; }
  finally { clearTimeout(t); }
}

async function resolve(row, hintCity, gkey) {
  const hint = curHint(row.p);
  const city = hint.city || hintCity || null;
  const q = [row.n, row.t && row.t !== 'address' ? row.t : null, city].filter(Boolean).join(', ');
  const body = {
    textQuery: q, maxResultCount: 3, languageCode: 'en-GB',
  };
  if (hint.region) body.regionCode = hint.region;
  const d = await gFetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Goog-Api-Key': gkey,
      'X-Goog-FieldMask': ['places.id','places.displayName','places.formattedAddress',
        'places.shortFormattedAddress','places.location','places.primaryType',
        'places.primaryTypeDisplayName','places.types','places.priceLevel',
        'places.rating','places.userRatingCount','places.businessStatus',
        'places.addressComponents'].join(',') },
    body: JSON.stringify(body),
  }, 2800);
  const places = (d && d.places) || [];
  if (!places.length) return null;

  /* pick the candidate whose name actually matches, preferring one in the
     hinted city — a global search for "Tavern" finds a hundred taverns */
  const want = slug(row.n);
  const scored = places.map(p => {
    const got = slug((p.displayName||{}).text || '');
    let s = 0;
    if (got === want) s += 3;
    else if (got.startsWith(want) || want.startsWith(got)) s += 2;
    else if (got.includes(want) || want.includes(got)) s += 1;
    const L = p.location || {};
    if (city && new RegExp(city.split(',')[0], 'i').test(p.formattedAddress || '')) s += 2;
    if (row.r && p.rating && Math.abs(p.rating - row.r) <= 0.2) s += 1;
    if (row.c && p.userRatingCount && Math.abs(p.userRatingCount - row.c) / row.c < 0.35) s += 2;
    return { p, s, lat: L.latitude, lng: L.longitude };
  }).filter(x => isFinite(x.lat)).sort((a,b) => b.s - a.s);
  const best = scored[0];
  if (!best || best.s < 1) return null;

  const comps = best.p.addressComponents || [];
  const pick = t => (comps.find(c => (c.types||[]).includes(t)) || {}).longText || null;
  return {
    id: best.p.id,
    name: (best.p.displayName||{}).text || row.n,
    lat: best.lat, lng: best.lng,
    addr: best.p.shortFormattedAddress || best.p.formattedAddress || null,
    pc: pick('postal_code'),
    town: pick('postal_town') || pick('locality') || pick('administrative_area_level_2'),
    hood: pick('neighborhood') || pick('sublocality') || pick('sublocality_level_1'),
    country: pick('country'),
    priceLevel: best.p.priceLevel || null,
    rating: best.p.rating || null, count: best.p.userRatingCount || null,
    types: best.p.types || [], primary: best.p.primaryType || null,
    primaryText: (best.p.primaryTypeDisplayName||{}).text || null,
    status: best.p.businessStatus || null,
    score: best.s,
  };
}

// the bank's own record shape, as saved.mjs produces it
function bankShape(row, g) {
  return {
    n: g.name, aka: g.name === row.n ? [] : [row.n],
    t: g.primaryText || row.t || null,
    c: kindOf(row, g), lat: g.lat, lng: g.lng,
    area: g.hood || g.town || null, hood: g.hood || null, boro: g.town || null, reg: null,
    addr: g.addr, pc: g.pc,
    tags: [], price: null, conf: 'lamp', fixed: true, orders: [], prices: [], vibes: [],
    // Angus's own words are the reason the place is here — they lead
    m: [{ t: row.note ? 'Angus’s note' : 'From Angus’s list (Lamp)',
          u: null, b: row.note || '' }],
    src: 'lamp',
    cui: null,
    band: bandFrom(row.p, g.priceLevel),
    rat: g.rating != null ? String(g.rating) : (row.r != null ? String(row.r) : null),
    rev: g.count != null ? String(g.count) : (row.c != null ? String(row.c) : null),
    gid: g.id,
    tmp: row.tmp ? 1 : undefined,
    savedAt: Date.now(),
  };
}

export default async (req) => {
  const started = Date.now();
  const deadline = started + 8500;
  const left = () => deadline - Date.now();

  let store;
  try { store = getStore({ name: 'otp-bank', consistency: 'strong' }); }
  catch (e) { return J({ ok: false, error: 'no_store', detail: String(e && e.message || e) }); }
  const gkey = googleKey();
  if (!gkey) return J({ ok: false, error: 'no_google_key' });

  let body = {};
  if (req && req.method === 'POST') { try { body = await req.json(); } catch (e) {} }

  const read = async (k, d) => { try { const v = await store.get(k, { type: 'json' }); return v ?? d; } catch (e) { return d; } };
  const london = await read(LKEY, []);
  const world = await read(WKEY, []);
  let cur = await read(CKEY, { i: 0, resolved: 0, unresolved: [], lastCity: 'London' });

  if (body.action === 'status')
    return J({ ok: true, total: LAMP.length, cursor: cur.i, london: london.length,
      world: world.length, unresolved: (cur.unresolved||[]).length,
      complete: cur.i >= LAMP.length });
  if (body.action === 'reset') {
    await store.setJSON(CKEY, { i: 0, resolved: 0, unresolved: [], lastCity: 'London' });
    return J({ ok: true, reset: true });
  }
  if (body.action === 'list')   // the app reads the London half at boot
    return J({ ok: true, places: london, count: london.length,
      progress: { done: cur.i, total: LAMP.length } });
  if (body.action === 'world')  // the travel layer, when it exists
    return J({ ok: true, places: world, count: world.length });

  if (cur.i >= LAMP.length)
    return J({ ok: true, complete: true, london: london.length, world: world.length,
      unresolved: (cur.unresolved||[]).length });

  const haveL = new Set(london.map(p => slug(p.n)));
  const haveW = new Set(world.map(p => slug(p.n)));
  const batch = LAMP.slice(cur.i, cur.i + PER_RUN);
  let addedL = 0, addedW = 0, missed = 0;
  let lastCity = cur.lastCity || 'London';

  for (const row of batch) {
    if (left() < 2200) break;
    cur.i++;
    if (haveL.has(slug(row.n)) || haveW.has(slug(row.n))) continue;
    const g = await resolve(row, lastCity, gkey);
    if (!g) { missed++; (cur.unresolved = cur.unresolved || []).push(row.n); continue; }
    if (g.status && g.status !== 'OPERATIONAL') { missed++; continue; }
    if (inLondon(g.lat, g.lng)) {
      london.push(bankShape(row, g)); haveL.add(slug(g.name)); addedL++;
      lastCity = 'London';
    } else {
      world.push({ n: g.name, lat: g.lat, lng: g.lng, addr: g.addr,
        city: g.town || null, country: g.country || null,
        t: g.primaryText || row.t || null, c: kindOf(row, g),
        note: row.note || null, rat: g.rating != null ? String(g.rating) : null,
        band: bandFrom(row.p, g.priceLevel), gid: g.id, src: 'lamp' });
      haveW.add(slug(g.name)); addedW++;
      // the neighbourhood effect: the next ambiguous name is probably here too
      if (g.town) lastCity = [g.town, g.country].filter(Boolean).join(', ');
    }
  }

  cur.lastCity = lastCity;
  cur.resolved = london.length + world.length;
  if (cur.unresolved && cur.unresolved.length > 300) cur.unresolved = cur.unresolved.slice(-300);
  if (addedL) await store.setJSON(LKEY, london);
  if (addedW) await store.setJSON(WKEY, world);
  await store.setJSON(CKEY, cur);

  return J({ ok: true, cursor: cur.i, of: LAMP.length,
    addedLondon: addedL, addedWorld: addedW, missed,
    london: london.length, world: world.length, lastCity, ms: Date.now() - started });
};
