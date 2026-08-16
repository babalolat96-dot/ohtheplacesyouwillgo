// Opening hours, photo and live rating for one venue, fetched only when a card
// is opened. Two Google calls at most, both inside the free monthly allowance
// at any sane usage. The key stays server side.

const KEY_NAMES = ['GOOGLE_PLACES_KEY', 'GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY', 'PLACES_KEY'];

function findKey() {
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (/^AIza[0-9A-Za-z_-]{20,}$/.test(String(v || '').trim())) return String(v).trim();
  }
  return null;
}

const BASE = 'https://places.googleapis.com/v1';

// find the place, preferring an exact spot near the coordinates we already hold
async function findPlace(key, name, lat, lng) {
  const body = {
    textQuery: name + ', London',
    maxResultCount: 3,
    languageCode: 'en-GB',
    regionCode: 'GB',
  };
  if (lat && lng) {
    body.locationBias = {
      circle: { center: { latitude: lat, longitude: lng }, radius: 500 },
    };
  }
  const r = await fetch(BASE + '/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // ids + location only: the cheapest tier
      'X-Goog-FieldMask': 'places.id,places.location,places.displayName',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { error: 'search_' + r.status, detail: (await r.text()).slice(0, 300) };
  const d = await r.json();
  const list = d.places || [];
  if (!list.length) return { error: 'not_found' };
  if (!lat || !lng) return { id: list[0].id, name: list[0].displayName && list[0].displayName.text };
  // pick whichever sits closest to the pin we already trust
  let best = null;
  for (const p of list) {
    const L = p.location || {};
    const dy = (L.latitude - lat) * 111;
    const dx = (L.longitude - lng) * 111 * Math.cos(lat * Math.PI / 180);
    const km = Math.sqrt(dy * dy + dx * dx);
    if (!best || km < best.km) best = { km, id: p.id, name: p.displayName && p.displayName.text };
  }
  if (best.km > 1.2) return { error: 'too_far', km: best.km };
  return { id: best.id, name: best.name, km: best.km };
}

async function getDetails(key, id) {
  const fields = [
    'id', 'displayName', 'formattedAddress', 'googleMapsUri',
    'regularOpeningHours', 'currentOpeningHours',
    'rating', 'userRatingCount', 'priceLevel',
    'websiteUri', 'nationalPhoneNumber', 'businessStatus',
    'photos',
  ].join(',');
  const r = await fetch(BASE + '/places/' + encodeURIComponent(id) +
    '?languageCode=en-GB&regionCode=GB', {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields },
  });
  if (!r.ok) return { error: 'details_' + r.status, detail: (await r.text()).slice(0, 300) };
  return await r.json();
}

function shapeHours(d) {
  const h = d.currentOpeningHours || d.regularOpeningHours;
  if (!h) return null;
  return {
    openNow: typeof h.openNow === 'boolean' ? h.openNow : null,
    today: null,           // filled in on the client, which knows the device's day
    week: h.weekdayDescriptions || null,
  };
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const name = (body.name || '').toString().slice(0, 120);
  const lat = Number(body.lat) || null;
  const lng = Number(body.lng) || null;
  let id = (body.id || '').toString().slice(0, 200) || null;
  if (!name && !id)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'need a name or an id' }) };

  const key = findKey();
  if (!key)
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_key' }) };

  try {
    let matched = null;
    if (!id) {
      const f = await findPlace(key, name, lat, lng);
      if (f.error) return { statusCode: 200, headers, body: JSON.stringify(f) };
      id = f.id; matched = f;
    }
    const d = await getDetails(key, id);
    if (d.error) return { statusCode: 200, headers, body: JSON.stringify(d) };

    const photoName = (d.photos && d.photos[0] && d.photos[0].name) || null;
    return { statusCode: 200, headers, body: JSON.stringify({
      id,
      name: d.displayName && d.displayName.text,
      address: d.formattedAddress || null,
      mapsUri: d.googleMapsUri || null,
      hours: shapeHours(d),
      rating: d.rating || null,
      ratingCount: d.userRatingCount || null,
      priceLevel: d.priceLevel || null,
      website: d.websiteUri || null,
      phone: d.nationalPhoneNumber || null,
      status: d.businessStatus || null,
      // the client asks for the image through our own /api/photo so the key never ships
      photo: photoName ? '/api/photo?name=' + encodeURIComponent(photoName) + '&w=800' : null,
      matchedKm: matched && matched.km != null ? Math.round(matched.km * 1000) : null,
    }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'exception', detail: String(e) }) };
  }
};
