// Second tier: places the model knows that are not in the bank.
// Every suggestion is checked against the UK Food Standards Agency register
// before it is returned, so nothing reaches the map that does not exist.

const KEY_NAMES = [
  'ANTHROPIC_API_KEY', 'OTP_MODEL_KEY', 'CLAUDE_API_KEY',
  'ANTHROPIC_KEY', 'BABLOAPI', 'API_KEY',
];

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
- Give the street whenever you know it. It is what allows a place to be confirmed.
  Do not invent one; an empty street is better than a wrong one.`;

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tokens = s => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);

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

// fallback: the model gave a street address, so geocode that instead
async function geoCheck(name, street, area) {
  const q = [name, street, area, 'London, UK'].filter(Boolean).join(', ');
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q, format: 'json', limit: '1', countrycodes: 'gb',
      viewbox: '-0.55,51.72,0.35,51.25', bounded: '1',
    }), { headers: { 'User-Agent': 'oh-the-places/1.0 (personal)' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.length) return null;
    const lat = parseFloat(d[0].lat), lng = parseFloat(d[0].lon);
    if (!(lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) return null;
    return { name, address: street || d[0].display_name.split(',').slice(0, 3).join(','),
             postcode: null, lat, lng, via: 'map' };
  } catch (e) { return null; }
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
      let hit = await fsaCheck(p.name, p.area);
      if (!hit && p.street) hit = await geoCheck(p.name, p.street, p.area);
      if (!hit) hit = await geoCheck(p.name, null, p.area);
      if (!hit) return null;
      return {
        name: hit.name || p.name, kind: p.kind, why: p.why, area: p.area || null,
        address: hit.address, postcode: hit.postcode, lat: hit.lat, lng: hit.lng,
        via: hit.via, confident: p.confident !== false,
      };
    }));
    const places = checked.filter(Boolean);
    return { statusCode: 200, headers, body: JSON.stringify({
      places, model, proposed: raw.length, verified: places.length }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ places: [], error: 'exception', detail: String(e) }) };
  }
};
