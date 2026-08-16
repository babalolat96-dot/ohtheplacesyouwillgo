// Second tier: places the model knows that are not in the bank.
// Every suggestion is checked against the UK Food Standards Agency register
// before it is returned, so nothing reaches the map that does not exist.

const KEY_NAMES = [
  'ANTHROPIC_API_KEY', 'OTP_MODEL_KEY', 'CLAUDE_API_KEY',
  'ANTHROPIC_KEY', 'BABLOAPI', 'API_KEY',
];
const G_KEY_NAMES = ['GOOGLE_PLACES_KEY', 'GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY', 'PLACES_KEY'];

function googleKey() {
  for (const n of G_KEY_NAMES) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  for (const v of Object.values(process.env)) {
    if (/^AIza[0-9A-Za-z_-]{20,}$/.test(String(v || '').trim())) return String(v).trim();
  }
  return null;
}

// Google is the best register of small bars, and the only one that tells us
// what kind of thing a result is. A solicitors' office is not a bar.
const G_BAD = new Set([
  'lawyer', 'accounting', 'insurance_agency', 'real_estate_agency', 'finance',
  'bank', 'atm', 'consultant', 'corporate_office', 'government_office',
  'local_government_office', 'city_hall', 'courthouse', 'post_office',
  'doctor', 'dentist', 'hospital', 'pharmacy', 'drugstore', 'veterinary_care',
  'funeral_home', 'cemetery', 'school', 'primary_school', 'secondary_school',
  'university', 'child_care_agency', 'church', 'mosque', 'synagogue',
  'place_of_worship', 'police', 'fire_station', 'car_repair', 'car_dealer',
  'gas_station', 'parking', 'storage', 'moving_company', 'plumber',
  'electrician', 'general_contractor', 'locksmith', 'laundry',
  'travel_agency', 'employment_agency',
]);
const G_GOOD = new Set([
  'restaurant', 'bar', 'pub', 'wine_bar', 'bar_and_grill', 'cafe', 'coffee_shop',
  'bakery', 'night_club', 'meal_takeaway', 'food', 'food_court', 'ice_cream_shop',
  'sandwich_shop', 'tea_house', 'dessert_shop', 'diner', 'brunch_restaurant',
  'breakfast_restaurant', 'fine_dining_restaurant', 'art_gallery', 'museum',
  'tourist_attraction', 'performing_arts_theater', 'movie_theater', 'concert_hall',
  'cultural_landmark', 'historical_place', 'book_store', 'record_store', 'market',
  'shopping_mall', 'store', 'park', 'garden', 'plaza', 'event_venue', 'hotel',
]);
function gIsVenue(p) {
  const types = p.types || [];
  const primary = p.primaryType || types[0] || '';
  if (G_BAD.has(primary)) return false;
  if (types.some(t => G_BAD.has(t)) && !types.some(t => G_GOOD.has(t))) return false;
  if (G_GOOD.has(primary) || /_restaurant$/.test(primary) || /_store$/.test(primary)) return true;
  return types.some(t => G_GOOD.has(t) || /_restaurant$/.test(t));
}

async function googleCheck(name, area, street) {
  const key = googleKey();
  if (!key) return null;
  const q = [name, street, area, 'London'].filter(Boolean).join(', ');
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.shortFormattedAddress,' +
          'places.formattedAddress,places.location,places.primaryType,places.types,places.businessStatus',
      },
      body: JSON.stringify({
        textQuery: q, maxResultCount: 5, languageCode: 'en-GB', regionCode: 'GB',
        locationBias: { rectangle: {
          low: { latitude: 51.25, longitude: -0.56 },
          high: { latitude: 51.72, longitude: 0.34 } } },
      }),
    });
    if (!r.ok) return null;
    for (const p of ((await r.json()).places || [])) {
      const L = p.location || {};
      if (!(L.latitude > 51.2 && L.latitude < 51.8 && L.longitude > -0.6 && L.longitude < 0.4)) continue;
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      if (!gIsVenue(p)) continue;
      const got = (p.displayName || {}).text || '';
      if (!nameMatches(got, name)) continue;
      return {
        name: got || name,
        address: p.shortFormattedAddress || p.formattedAddress || null,
        postcode: null, lat: L.latitude, lng: L.longitude,
        placeId: p.id, via: 'google',
      };
    }
  } catch (e) {}
  return null;
}

function findKey() {
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  for (const v of Object.values(process.env)) {
    if (typeof v === 'string' && /^sk-ant-/.test(v.trim())) return v.trim();
  }
  return null;
}

let cachedModel = null;
async function pickModel(key) {
  if (cachedModel) return cachedModel;
  if (process.env.OTP_MODEL) return (cachedModel = process.env.OTP_MODEL);
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (r.ok) {
      const ids = ((await r.json()).data || []).map(m => m.id);
      cachedModel = ids.find(i => /haiku/i.test(i)) || ids.find(i => /sonnet/i.test(i)) || ids[0];
      if (cachedModel) return cachedModel;
    }
  } catch (e) {}
  return (cachedModel = 'claude-haiku-4-5');
}

const SCHEMA = {
  name: 'suggestions',
  description: 'Real London venues that answer the request.',
  input_schema: {
    type: 'object',
    properties: {
      places: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The venue name as it trades, exactly.' },
            area: { type: 'string', description: 'Neighbourhood, e.g. Notting Hill.' },
            street: { type: 'string', description: 'Street address if you know it, e.g. "29 Romilly Street". This is what lets the place be confirmed, so give it whenever you know it. Leave empty rather than guess.' },
            kind: { type: 'string', enum: ['eat', 'drink', 'coffee', 'outdoors', 'culture', 'shop'] },
            why: { type: 'string', description: 'One short line on why it fits. Under 18 words.' },
            confident: { type: 'boolean', description: 'False if you are unsure this place is currently open or exists under this name.' },
          },
          required: ['name', 'kind', 'why'],
        },
      },
    },
    required: ['places'],
  },
};

const SYSTEM = `You suggest real London venues. You are the second opinion: the user
already has their own curated list, and you are filling gaps in it.

Rules:
- Only real, currently trading London venues you are genuinely confident about.
- Fewer good answers beats a padded list. Three certain ones is a good answer.
- Set confident=false for anything you are unsure about rather than dropping it.
- Never repeat a venue that is already in the user's list, which is given to you.
- If the request mentions a specific venue, places physically near it are ideal,
  including anything in the same building.
- Give the street whenever you know it, including the number. It is what allows a
  place to be confirmed, and small or new bars are often in no public register.
  Do not invent one; an empty street is better than a wrong one.
- A bar inside, above or below another venue is a good answer. Give the building's
  address in street, and say the relationship in why.`;

const norm = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const STOP = new Set(['the', 'and']);
const tokens = s => (s || '').toLowerCase().replace(/&/g, ' and ')
  .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));

function nameMatches(candidate, target) {
  const c = norm(candidate), t = norm(target);
  if (!c || !t) return false;
  if (c === t || c.startsWith(t) || t.startsWith(c) || c.includes(t) || t.includes(c)) return true;
  const ct = tokens(candidate), tt = tokens(target);
  if (!tt.length) return false;
  const hit = tt.filter(w => ct.some(x => x.startsWith(w) || w.startsWith(x))).length;
  return hit / tt.length >= 0.6;
}

async function fsaQuery(name, area) {
  const q = new URLSearchParams({ name, address: area ? area + ', London' : 'London', pageSize: '12' });
  try {
    const r = await fetch('https://api.ratings.food.gov.uk/Establishments?' + q, {
      headers: { 'x-api-version': '2', accept: 'application/json' },
    });
    if (!r.ok) return [];
    return ((await r.json()).establishments || []);
  } catch (e) { return []; }
}

async function fsaCheck(name, area) {
  // try the name as given, then stripped of punctuation, then its longest word
  const words = tokens(name);
  const variants = [name, name.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()];
  if (words.length) variants.push(words.slice().sort((a, b) => b.length - a.length)[0]);
  const seen = new Set();
  for (const v of variants) {
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    for (const e of await fsaQuery(v, area)) {
      if (!nameMatches(e.BusinessName, name)) continue;
      const g = e.geocode || {};
      const lat = parseFloat(g.latitude), lng = parseFloat(g.longitude);
      if (!(lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) continue;
      const addr = [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4]
        .filter(Boolean).join(', ');
      return { name: e.BusinessName, address: addr, postcode: e.PostCode, lat, lng, via: 'register' };
    }
  }
  return null;
}

// fallback: look the name up on the map, trying progressively looser forms
const GENERIC = /\b(townhouse|town house|restaurant|restaurants|bar|bars|cafe|caf\u00e9|kitchen|house|club|rooms|room|lounge|tavern|the|london)\b/gi;

async function nom(q) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q, format: 'json', limit: '3', viewbox: '-0.55,51.72,0.35,51.25', bounded: '1',
    }), { headers: { 'User-Agent': 'oh-the-places/1.0 (personal)' } });
    if (!r.ok) return [];
    return await r.json();
  } catch (e) { return []; }
}

async function geoCheck(name, street, area) {
  const short = (name || '').replace(GENERIC, ' ').replace(/\s+/g, ' ').trim();
  const tries = [];
  if (street) tries.push({ q: name + ', ' + street, strict: false });
  if (street) tries.push({ q: street + ', London', strict: false });
  if (area) tries.push({ q: name + ', ' + area, strict: true });
  tries.push({ q: name, strict: true });
  if (short && short.length > 2 && short.toLowerCase() !== (name || '').toLowerCase()) {
    if (area) tries.push({ q: short + ', ' + area, strict: true });
    tries.push({ q: short, strict: true });
  }
  const want = tokens(name).concat(tokens(short));
  const seen = new Set();
  for (const t of tries) {
    if (!t.q || seen.has(t.q.toLowerCase())) continue;
    seen.add(t.q.toLowerCase());
    for (const h of await nom(t.q)) {
      const lat = parseFloat(h.lat), lng = parseFloat(h.lon);
      if (!(lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) continue;
      const head = (h.display_name || '').split(',')[0];
      if (t.strict) {
        // a name-only lookup must land on an actual venue, not a building or a street
        // no 'office': it let a solicitors' office answer for a bar of the same name
        const POI = ['amenity', 'shop', 'tourism', 'leisure', 'craft'];
        if (!POI.includes(h.class)) continue;
        if (!nameMatches(head, name) && !nameMatches(head, short)) continue;
        return {
          name: head || name,
          address: (h.display_name || '').split(',').slice(0, 3).join(',').trim(),
          postcode: null, lat, lng, via: 'map',
        };
      }
      // matched on the street the model gave: the address is real, the name is its claim
      return {
        name, address: (h.display_name || '').split(',').slice(0, 3).join(',').trim(),
        postcode: null, lat, lng, via: 'address',
      };
    }
  }
  return null;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const q = (body.q || '').toString().slice(0, 400);
  const known = (Array.isArray(body.known) ? body.known : []).slice(0, 40).join(', ');
  if (!q.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'empty' }) };

  const key = findKey();
  if (!key) return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'no_key' }) };

  try {
    const model = await pickModel(key);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 700, system: SYSTEM,
        tools: [SCHEMA], tool_choice: { type: 'tool', name: 'suggestions' },
        messages: [{ role: 'user', content:
          `Request: ${q}\n\nAlready in their list, do not repeat: ${known || '(nothing relevant)'}` }],
      }),
    });
    const d = await r.json();
    if (!r.ok)
      return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'api',
        detail: (d.error && d.error.message) || '' }) };
    const block = (d.content || []).find(c => c.type === 'tool_use');
    const raw = (block && block.input && block.input.places) || [];

    // verify every one against the FSA register, in parallel
    const checked = await Promise.all(raw.slice(0, 4).map(async p => {
      // Google first: it carries the small bars, and it knows what a place is
      let hit = await googleCheck(p.name, p.area, p.street);
      if (!hit) hit = await fsaCheck(p.name, p.area);
      if (!hit && p.street) hit = await geoCheck(p.name, p.street, p.area);
      if (!hit) hit = await geoCheck(p.name, null, p.area);
      if (!hit) return null;
      return {
        name: hit.name || p.name, kind: p.kind, why: p.why, area: p.area || null,
        address: hit.address, postcode: hit.postcode, lat: hit.lat, lng: hit.lng,
        placeId: hit.placeId || null,
        via: hit.via, confident: p.confident !== false,
      };
    }));
    const places = checked.filter(Boolean);
    const out = { places, model, proposed: raw.length, verified: places.length };
    if (body.debug) out.raw = raw;
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'exception', detail: String(e) }) };
  }
};
