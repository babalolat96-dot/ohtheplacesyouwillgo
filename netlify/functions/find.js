// Resolve a typed name to a real venue, using Google as the primary source.
// Google knows the small bars that no public register carries, and it knows
// what kind of thing each result is, which is what stops a solicitors' office
// standing in for a bar of the same name.

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

const BASE = 'https://places.googleapis.com/v1';

// things you would actually go to
const GOOD = new Set([
  'restaurant', 'bar', 'pub', 'wine_bar', 'bar_and_grill', 'cafe', 'coffee_shop',
  'bakery', 'night_club', 'meal_takeaway', 'meal_delivery', 'food', 'food_court',
  'ice_cream_shop', 'sandwich_shop', 'juice_shop', 'tea_house', 'dessert_shop',
  'diner', 'brunch_restaurant', 'breakfast_restaurant', 'fine_dining_restaurant',
  'art_gallery', 'museum', 'tourist_attraction', 'performing_arts_theater',
  'movie_theater', 'concert_hall', 'cultural_landmark', 'historical_place',
  'book_store', 'record_store', 'market', 'shopping_mall', 'clothing_store',
  'gift_shop', 'store', 'department_store', 'florist',
  'park', 'garden', 'botanical_garden', 'national_park', 'hiking_area',
  'plaza', 'observation_deck', 'amusement_park', 'bowling_alley', 'casino',
  'event_venue', 'banquet_hall', 'hotel', 'lodging', 'spa', 'gym',
]);

// things you certainly are not taking a date to
const BAD = new Set([
  'lawyer', 'accounting', 'insurance_agency', 'real_estate_agency', 'finance',
  'bank', 'atm', 'consultant', 'corporate_office', 'government_office',
  'local_government_office', 'city_hall', 'courthouse', 'post_office',
  'doctor', 'dentist', 'hospital', 'pharmacy', 'drugstore', 'physiotherapist',
  'veterinary_care', 'funeral_home', 'cemetery', 'school', 'primary_school',
  'secondary_school', 'university', 'child_care_agency', 'church', 'mosque',
  'synagogue', 'hindu_temple', 'place_of_worship', 'police', 'fire_station',
  'car_repair', 'car_dealer', 'car_wash', 'gas_station', 'parking',
  'storage', 'moving_company', 'plumber', 'electrician', 'roofing_contractor',
  'general_contractor', 'painter', 'locksmith', 'laundry', 'travel_agency',
  'employment_agency', 'telecommunications_service_provider', 'electrician',
]);

function isVenue(p) {
  const types = p.types || [];
  const primary = p.primaryType || types[0] || '';
  if (BAD.has(primary)) return false;
  if (types.some(t => BAD.has(t)) && !types.some(t => GOOD.has(t))) return false;
  if (GOOD.has(primary)) return true;
  if (/_restaurant$/.test(primary) || /_store$/.test(primary)) return true;
  if (types.some(t => GOOD.has(t) || /_restaurant$/.test(t))) return true;
  return false;
}

// "&" and "and" are the same word to a person typing, so they are here too
const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const STOP = new Set(['the', 'and', 'bar', 'cafe', 'london']);
const words = s => String(s || '').toLowerCase().replace(/&/g, ' and ')
  .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));

// does this result plausibly carry the name that was asked for?
function nameScore(got, asked) {
  const g = norm(got), a = norm(asked);
  if (!g || !a) return 0;
  if (g === a) return 1;
  if (g.startsWith(a) || a.startsWith(g)) return 0.85;
  if (g.includes(a) || a.includes(g)) return 0.7;
  const gw = words(got), aw = words(asked);
  if (!aw.length) return 0;
  const hit = aw.filter(w => gw.some(x => x.startsWith(w) || w.startsWith(x))).length;
  return 0.6 * (hit / aw.length);
}

const KIND_BY_TYPE = [
  [/bar|pub|night_club|wine|brewery|liquor/, 'drink'],
  [/cafe|coffee|tea_house|bakery/, 'coffee'],
  [/restaurant|food|meal_|diner|sandwich|ice_cream|dessert/, 'eat'],
  [/park|garden|hiking|plaza|observation/, 'outdoors'],
  [/museum|gallery|theater|theatre|concert|cultural|historical|landmark|tourist/, 'culture'],
  [/store|market|mall|shop/, 'shop'],
];
function kindOf(p) {
  const all = ((p.primaryType || '') + ' ' + (p.types || []).join(' ')).toLowerCase();
  for (const [re, k] of KIND_BY_TYPE) if (re.test(all)) return k;
  return 'eat';
}

async function searchText(key, query, bias) {
  const body = {
    textQuery: query,
    maxResultCount: 8,
    languageCode: 'en-GB',
    regionCode: 'GB',
    locationBias: bias || {
      // greater London, so a name alone cannot wander to another city
      rectangle: {
        low: { latitude: 51.25, longitude: -0.56 },
        high: { latitude: 51.72, longitude: 0.34 },
      },
    },
  };
  const r = await fetch(BASE + '/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // the cheaper tier: no hours, no photos. hours come from /api/place by id.
      'X-Goog-FieldMask': [
        'places.id', 'places.displayName', 'places.formattedAddress', 'places.shortFormattedAddress',
        'places.location', 'places.primaryType', 'places.types',
        'places.rating', 'places.userRatingCount', 'places.priceLevel',
        'places.businessStatus',
      ].join(','),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { error: 'search_' + r.status, detail: (await r.text()).slice(0, 300) };
  return { places: ((await r.json()).places) || [] };
}

const inLondon = p => {
  const L = p.location || {};
  return L.latitude > 51.2 && L.latitude < 51.8 && L.longitude > -0.6 && L.longitude < 0.4;
};

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const qRaw = (body.q || '').toString().trim().slice(0, 120);
  const area = (body.area || '').toString().trim().slice(0, 60);
  const near = (Number(body.lat) && Number(body.lng)) ? { lat: Number(body.lat), lng: Number(body.lng) } : null;
  if (!qRaw) return { statusCode: 400, headers, body: JSON.stringify({ error: 'empty' }) };

  const key = findKey();
  if (!key) return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'no_key' }) };

  const bias = near
    ? { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 3000 } }
    : null;

  try {
    // ask for the name as typed; London is added so a bare name stays in town
    const queries = [];
    const hasLondon = /\blondon\b/i.test(qRaw);
    queries.push(area ? `${qRaw}, ${area}, London` : (hasLondon ? qRaw : qRaw + ', London'));
    if (area) queries.push(hasLondon ? qRaw : qRaw + ', London');

    let raw = [], err = null;
    for (const query of queries) {
      const res = await searchText(key, query, bias);
      if (res.error) { err = res; continue; }
      raw = raw.concat(res.places || []);
      if (raw.some(p => isVenue(p) && nameScore((p.displayName || {}).text, qRaw) >= 0.7)) break;
    }
    if (!raw.length)
      return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: err ? err.error : 'not_found' }) };

    // de-duplicate, keep only real venues, rank by how well the name matches
    const seen = new Set();
    const scored = [];
    for (const p of raw) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!inLondon(p)) continue;
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const venue = isVenue(p);
      const ns = nameScore((p.displayName || {}).text, qRaw);
      // a name-led search must actually return that name, and must be a venue
      if (!venue) continue;
      if (ns < 0.5) continue;
      scored.push({
        id: p.id,
        name: (p.displayName || {}).text || qRaw,
        address: p.shortFormattedAddress || p.formattedAddress || null,
        lat: p.location.latitude,
        lng: p.location.longitude,
        kind: kindOf(p),
        type: p.primaryType || null,
        rating: p.rating || null,
        ratingCount: p.userRatingCount || null,
        priceLevel: p.priceLevel || null,
        score: ns,
        via: 'google',
      });
    }
    scored.sort((a, b) => (b.score - a.score) || ((b.ratingCount || 0) - (a.ratingCount || 0)));

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        places: scored.slice(0, 6),
        considered: raw.length,
        rejected: raw.length - scored.length,
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'exception', detail: String(e) }) };
  }
};
