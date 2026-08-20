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

async function googleCheck(name, area, street, near) {
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
        // when we know where the user is standing, look THERE first
        locationBias: near
          ? { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 3000 } }
          : { rectangle: {
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
            why: { type: 'string', description: 'One short line on why it fits, about the PLACE — its character, room, what it serves. Under 18 words. NEVER mention opening hours, closing times, or how late it stays open: you do not know them and they are checked separately.' },
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
  address in street, and say the relationship in why.

HOURS ARE NOT YOURS TO CLAIM. Never write "open till 3am", "late hours", "open
late", "serves till dawn" or any variation, in the why field or anywhere else. Opening
times are looked up from the live register after you answer, and a claim of
yours that contradicts them is a lie the user sees. If lateness is what was
asked for, name places you believe genuinely trade at that hour and say WHY the
place is good — the hours check is done for you.`;

/* ---- hours, from Google, never from the model ----
   A suggestion that does not actually open when the user asked is not a
   suggestion. We hold the place id from googleCheck, so one Details call
   settles it. Where Google genuinely has no hours we say so rather than
   guess: "couldn't check" is an honest answer, an invented one is not. */
const DAYNAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function tmin(h, m, mer) {
  h = +h; m = m ? +m : 0;
  if (mer) { const q = mer[0].toLowerCase();
    if (q === 'p' && h < 12) h += 12;
    if (q === 'a' && h === 12) h = 0; }
  return h * 60 + m;
}
// same reader as the app: Google mixes 24h, "5:00 – 11:00 PM" and "12:00 AM"
function parseWeek(lines) {
  const out = {};
  (lines || []).forEach(raw => {
    const line = String(raw).replace(/[\u00a0\u2009\u202f\u2007\u3000]/g, ' ').replace(/[\u2010-\u2015\u2212]/g, '-');
    const i = line.indexOf(':'); if (i < 0) return;
    const di = DAYNAMES.findIndex(d => d.toLowerCase() === line.slice(0, i).trim().toLowerCase());
    if (di < 0) return;
    const rest = line.slice(i + 1).trim();
    if (/closed/i.test(rest)) { out[di] = []; return; }
    if (/24\s*hours|24\/7/i.test(rest)) { out[di] = [[0, 1440]]; return; }
    const spans = [];
    rest.split(',').forEach(part => {
      const toks = [];
      const re = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/gi;
      const bare = /(\d{1,2}):(\d{2})/g;
      let m;
      while ((m = re.exec(part))) toks.push({ h: m[1], m: m[2], mer: m[3], at: m.index });
      if (toks.length < 2) {
        while ((m = bare.exec(part))) {
          if (toks.some(t => Math.abs(t.at - m.index) < 3)) continue;
          toks.push({ h: m[1], m: m[2], mer: null, at: m.index });
        }
        toks.sort((x, y) => x.at - y.at);
      }
      if (toks.length < 2) return;
      const st = toks[0], en = toks[1];
      let a, b = tmin(en.h, en.m, en.mer);
      if (!st.mer && en.mer) {
        a = tmin(st.h, st.m, en.mer);
        if (a >= b) { const alt = tmin(st.h, st.m, en.mer[0].toLowerCase() === 'p' ? 'a' : 'p'); if (alt < b) a = alt; }
      } else a = tmin(st.h, st.m, st.mer);
      spans.push(a === b ? [0, 1440] : [a, b]);
    });
    if (spans.length) out[di] = spans;
  });
  return out;
}
function openAtWeek(week, dow, mins) {
  if (!week) return null;
  const today = week[dow], yest = week[(dow + 6) % 7];
  if (today === undefined && yest === undefined) return null;
  for (const [a, b] of (today || [])) if (b > a ? (mins >= a && mins < b) : (mins >= a)) return true;
  for (const [a, b] of (yest || [])) if (b <= a && mins < b) return true;   // ran past midnight
  return false;
}
function closesOnWeek(week, dow) {
  const spans = week && week[dow];
  if (!spans || !spans.length) return null;
  let best = null;
  for (const [a, b] of spans) { const end = b > a ? b : b + 1440; if (best === null || end > best) best = end; }
  return best;
}
const hhmm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

async function realHours(placeId) {
  const key = googleKey();
  if (!key || !placeId) return null;
  try {
    const r = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId) +
      '?languageCode=en-GB&regionCode=GB', {
      headers: { 'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'regularOpeningHours,currentOpeningHours,businessStatus' } });
    if (!r.ok) return null;
    const d = await r.json();
    const h = d.currentOpeningHours || d.regularOpeningHours;
    if (!h || !h.weekdayDescriptions) return null;
    return { week: parseWeek(h.weekdayDescriptions), status: d.businessStatus || null };
  } catch (e) { return null; }
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
  // their taste, distilled from favourites and saves — a steer, never a cage
  let tasteLine = '';
  if (body.taste && typeof body.taste === 'object') {
    const t = body.taste;
    const arr = x => (Array.isArray(x) ? x.filter(v => typeof v === 'string').slice(0, 6) : []);
    const bits = [];
    if (arr(t.tags).length) bits.push('leans toward: ' + arr(t.tags).join(', '));
    if (arr(t.cuisines).length) bits.push('cuisines they favour: ' + arr(t.cuisines).join(', '));
    if (arr(t.bands).length) bits.push('usual price band: ' + arr(t.bands).join('/'));
    if (arr(t.favourites).length) bits.push('favourite places: ' + arr(t.favourites).join(', '));
    if (bits.length) tasteLine = '\n\nTheir taste (from what they favourite and save): ' +
      bits.join('; ') + '. Prefer places that fit it when the request leaves room, ' +
      'but never ignore an explicit ask to match it.';
  }
  /* where they are and when they asked. This is what turns "open near me"
     from a list of famous central places into a local answer. */
  let near = null;
  if (body.near && typeof body.near === 'object'
      && Number.isFinite(+body.near.lat) && Number.isFinite(+body.near.lng)
      && +body.near.lat > 51.2 && +body.near.lat < 51.8
      && +body.near.lng > -0.6 && +body.near.lng < 0.4) {
    near = { lat: +body.near.lat, lng: +body.near.lng,
             label: String(body.near.label || 'their location').slice(0, 60) };
  }
  const when = body.when ? String(body.when).slice(0, 60) : null;
  const openNow = body.openNow === true;
  /* the moment the answer has to survive. Sent as an ISO instant by the app;
     converted to London wall-clock, because that is what Google's week means. */
  let needAt = null;
  if (body.needAt) {
    const t = new Date(String(body.needAt));
    if (!isNaN(t)) {
      const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London',
        weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(t).reduce((o, x) => (o[x.type] = x.value, o), {});
      const dow = DAYNAMES.findIndex(d => d === f.weekday);
      if (dow >= 0) needAt = { dow, mins: (+f.hour) * 60 + (+f.minute),
                               label: f.weekday + ' ' + f.hour + ':' + f.minute };
    }
  }
  let nearLine = '';
  if (near) {
    nearLine = `\n\nThe user is at ${near.label} (${near.lat.toFixed(4)}, ${near.lng.toFixed(4)}) right now. ` +
      'Suggest places genuinely close to those coordinates — walking distance or a few minutes away, ' +
      'within roughly 2–3 km. Do NOT default to famous central-London venues; name the good ' +
      'local options in that actual neighbourhood, the ones someone who lives there would know.';
    if (when) nearLine += `\nIt is ${when} in London.` +
      (openNow ? ' They need somewhere open and serving RIGHT NOW — only suggest places very likely to be open at this exact time.' : '');
  }
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
          `Request: ${q}\n\nAlready in their list, do not repeat: ${known || '(nothing relevant)'}${nearLine}${tasteLine}` }],
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
      let hit = await googleCheck(p.name, p.area, p.street, near);
      if (!hit) hit = await fsaCheck(p.name, p.area);
      if (!hit && p.street) hit = await geoCheck(p.name, p.street, p.area);
      if (!hit) hit = await geoCheck(p.name, null, p.area);
      if (!hit) return null;
      /* strip any hours talk the model smuggled in anyway — the facts below
         are the only place hours may come from */
      const why = String(p.why || '').replace(
        /[^.]*\b(open|serving|serves|going)\b[^.]{0,30}\b(late|past|till|until|after)\b[^.]*\.?/gi, '').trim()
        || String(p.why || '').replace(/\b(open|opens)\b[^.]{0,20}\d{1,2}\s*(am|pm)/gi, '').trim();
      return {
        name: hit.name || p.name, kind: p.kind, why, area: p.area || null,
        address: hit.address, postcode: hit.postcode, lat: hit.lat, lng: hit.lng,
        placeId: hit.placeId || null,
        via: hit.via, confident: p.confident !== false,
      };
    }));
    let places = checked.filter(Boolean);

    /* ---- the hours gate ----
       If the ask carried a time, a place that does not actually open then is
       not an answer. Check every candidate against Google's own hours and
       DROP the ones that fail. Where Google has no hours at all, keep the
       place but mark it unchecked so the card can say so out loud. */
    let droppedShut = [], unchecked = 0;
    if (needAt) {
      const judged = await Promise.all(places.map(async q => {
        if (!q.placeId) { q.hoursKnown = false; unchecked++; return q; }
        const h = await realHours(q.placeId);
        if (!h || !h.week || !Object.keys(h.week).length) { q.hoursKnown = false; unchecked++; return q; }
        q.hoursKnown = true;
        q.openThen = openAtWeek(h.week, needAt.dow, needAt.mins);
        const co = closesOnWeek(h.week, needAt.dow);
        q.closesAt = co != null ? hhmm(co % 1440) : null;
        return q;
      }));
      places = judged.filter(q => {
        if (q.hoursKnown && q.openThen === false) { droppedShut.push(q.name + (q.closesAt ? ' (shuts ' + q.closesAt + ')' : '')); return false; }
        return true;
      });
    }
    /* the model may name somewhere plausible that verifies at its REAL address
       across town. When the ask is anchored, an answer 10km away is not an
       answer — drop it rather than pretend it is local. */
    if (near) {
      const km = p => {
        const R = 6371, dLa = (p.lat - near.lat) * Math.PI / 180, dLo = (p.lng - near.lng) * Math.PI / 180;
        const a = Math.sin(dLa / 2) ** 2 +
          Math.cos(near.lat * Math.PI / 180) * Math.cos(p.lat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
      };
      places = places.filter(p => !Number.isFinite(+p.lat) || km(p) <= 6);
    }
    const out = { places, model, proposed: raw.length, verified: places.length,
                  droppedShut, uncheckedHours: unchecked,
                  checkedAt: needAt ? needAt.label : null };
    if (body.debug) out.raw = raw;
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'exception', detail: String(e) }) };
  }
};
