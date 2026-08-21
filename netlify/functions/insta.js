// Reads screenshots of an Instagram post and returns the London venues named
// in it — each one verified against Google, the FSA register or the map
// before it can be offered, exactly like the wider search. The model only
// ever transcribes what is visible; verification decides what is real.

const KEY_NAMES = [
  'ANTHROPIC_API_KEY', 'OTP_MODEL_KEY', 'CLAUDE_API_KEY',
  'ANTHROPIC_KEY', 'BABLOAPI', 'API_KEY',
];
const G_KEY_NAMES = ['GOOGLE_PLACES_KEY', 'GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY', 'PLACES_KEY'];

function findKey() {
  // netlify dev injects a non-Anthropic ANTHROPIC_API_KEY: prefer whatever
  // actually looks like an Anthropic key; named-but-odd only as last resort
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && /^sk-ant-/.test(v.trim())) return v.trim();
  }
  for (const v of Object.values(process.env)) {
    if (typeof v === 'string' && /^sk-ant-/.test(v.trim())) return v.trim();
  }
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
}
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

/* ---- the same venue-verification chain as suggest.js ---- */
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

const GENERIC = /\b(townhouse|town house|restaurant|restaurants|bar|bars|cafe|café|kitchen|house|club|rooms|room|lounge|tavern|the|london)\b/gi;
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
  if (area) tries.push({ q: name + ', ' + area, strict: true });
  tries.push({ q: name, strict: true });
  const seen = new Set();
  for (const t of tries) {
    if (!t.q || seen.has(t.q.toLowerCase())) continue;
    seen.add(t.q.toLowerCase());
    for (const h of await nom(t.q)) {
      const lat = parseFloat(h.lat), lng = parseFloat(h.lon);
      if (!(lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) continue;
      const head = (h.display_name || '').split(',')[0];
      if (t.strict) {
        const POI = ['amenity', 'shop', 'tourism', 'leisure', 'craft'];
        if (!POI.includes(h.class)) continue;
        if (!nameMatches(head, name) && !nameMatches(head, short)) continue;
        return { name: head || name,
          address: (h.display_name || '').split(',').slice(0, 3).join(',').trim(),
          postcode: null, lat, lng, via: 'map' };
      }
      return { name,
        address: (h.display_name || '').split(',').slice(0, 3).join(',').trim(),
        postcode: null, lat, lng, via: 'address' };
    }
  }
  return null;
}

/* ---- best effort: read the caption straight from the link ----
   Instagram walls most server requests behind a login page, but some public
   posts serve a caption snippet in their link-preview meta tags. Try it;
   fail honestly. Screenshots remain the sure route. */
async function fetchCaption(link) {
  try {
    const r = await fetch(link, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
          'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 400000);
    if (/loginForm|accounts\/login/i.test(html) && !/og:description/i.test(html)) return null;
    const de = s => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const grab = prop => {
      const m = html.match(new RegExp('<meta[^>]+property="' + prop + '"[^>]+content="([^"]*)"', 'i'))
        || html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+property="' + prop + '"', 'i'));
      return m ? de(m[1]) : null;
    };
    const desc = grab('og:description'), title = grab('og:title');
    if (!desc && !title) return null;
    // og:title is usually '<account> on Instagram: "caption..."'
    let account = null;
    const tm = (title || '').match(/^@?([A-Za-z0-9._]+)\s+on Instagram/i);
    if (tm) account = tm[1];
    const text = [title, desc].filter(Boolean).join('\n').slice(0, 2500);
    return text.length > 30 ? { text, account } : null;
  } catch (e) { return null; }
}

/* ---- reading the screenshot ---- */
const SCHEMA = {
  name: 'post',
  description: 'What the Instagram post screenshots actually say.',
  input_schema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'The posting account handle, without the @, exactly as shown. Empty if not visible.' },
      caption: { type: 'string', description: 'The caption in the writer\'s own words, trimmed to the part about places. Under 300 characters. Empty if no caption is visible.' },
      places: {
        type: 'array', maxItems: 10,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Venue name exactly as written in the image. Never complete a name you cannot fully read.' },
            area: { type: 'string', description: 'Neighbourhood if the post states one.' },
            street: { type: 'string', description: 'Street address only if the post shows one.' },
            kind: { type: 'string', enum: ['eat', 'drink', 'coffee', 'outdoors', 'culture', 'shop'] },
            why: { type: 'string', description: 'What the post says about THIS venue, in the writer\'s words. Under 140 characters. Empty if it says nothing specific.' },
            confident: { type: 'boolean', description: 'False if the name is partially cut off, blurry, or you are unsure you read it right.' },
          },
          required: ['name', 'kind'],
        },
      },
    },
    required: ['places'],
  },
};

const SYSTEM = `You read screenshots of an Instagram post about places in London.
The images may be slides of a carousel, or frames sampled from a video —
the same post either way. You are a transcriber, not a recommender.

Rules:
- Extract ONLY venues actually named in the images. Never add places you know
  of that are not in the post, and never complete a name you cannot fully read.
- Text overlaid on the image or video counts — that is often where the names are.
- The writer's words matter: quote what the post says about each venue in "why",
  do not paraphrase into marketing language.
- The same venue seen in several slides or frames is listed once.
- Ignore usernames in comments, tagged people, and advertisers.
- If the post is not about places at all, return an empty places list.`;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter(x => typeof x === 'string' && x.length > 100 && x.length < 2600000)
    .slice(0, 8);
  const link = /^https:\/\/(www\.)?instagram\.com\//.test(String(body.link || ''))
    ? String(body.link).slice(0, 200) : null;
  if (!images.length && !link)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'no_images' }) };

  const key = findKey();
  if (!key) return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'no_key' }) };

  try {
    // link only: try to read the caption from Instagram's link preview
    let fetched = null;
    if (!images.length && link) {
      fetched = await fetchCaption(link);
      if (!fetched)
        return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'link_walled' }) };
    }

    const model = await pickModel(key);
    const content = images.map(b64 => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: b64.replace(/^data:image\/\w+;base64,/, '') },
    }));
    content.push({ type: 'text', text: images.length
      ? 'These are screenshots of one Instagram post. Read them.'
      : 'This is the link-preview text of one Instagram post — the caption may be '+
        'truncated, so extract only complete venue names:\n\n' + fetched.text });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 1200, system: SYSTEM,
        tools: [SCHEMA], tool_choice: { type: 'tool', name: 'post' },
        messages: [{ role: 'user', content }],
      }),
    });
    const d = await r.json();
    if (!r.ok)
      return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'api',
        detail: (d.error && d.error.message) || '', model }) };
    const block = (d.content || []).find(c => c.type === 'tool_use');
    const read = (block && block.input) || {};
    const raw = (read.places || []).slice(0, 10);

    // every extracted name must survive verification before it is offered
    const checked = await Promise.all(raw.map(async p => {
      let hit = await googleCheck(p.name, p.area, p.street);
      if (!hit) hit = await fsaCheck(p.name, p.area);
      if (!hit) hit = await geoCheck(p.name, p.street || null, p.area);
      if (!hit) return null;
      return {
        name: hit.name || p.name, kind: p.kind || 'eat',
        why: (p.why || '').slice(0, 200), area: p.area || null,
        address: hit.address, postcode: hit.postcode || null,
        lat: hit.lat, lng: hit.lng, placeId: hit.placeId || null,
        via: hit.via, confident: p.confident !== false,
      };
    }));
    const places = checked.filter(Boolean);
    return { statusCode: 200, headers, body: JSON.stringify({
      partial: !images.length || undefined,   // caption-only: slides/video not seen
      account: String(read.account || (fetched && fetched.account) || '').replace(/^@/, '').slice(0, 60) || null,
      caption: String(read.caption || '').slice(0, 320) || null,
      link, places, model,
      proposed: raw.length, verified: places.length,
      unreadable: raw.filter(p => p.confident === false).map(p => p.name),
    }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'exception', detail: String(e) }) };
  }
};
