// Turns a sentence into a structured query. It never sees the venue data:
// the page does the searching. The API key stays server side.

const KEY_NAMES = [
  'ANTHROPIC_API_KEY', 'OTP_MODEL_KEY', 'CLAUDE_API_KEY',
  'ANTHROPIC_KEY', 'BABLOAPI', 'API_KEY',
];

function findKey() {
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  // last resort: any env value that looks like an Anthropic key
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && /^sk-ant-/.test(v.trim())) return v.trim();
  }
  return null;
}

const FALLBACK_MODELS = [
  'claude-haiku-4-5', 'claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022',
  'claude-sonnet-4-5', 'claude-3-5-sonnet-latest',
];

let cachedModel = null;

async function pickModel(key) {
  if (cachedModel) return cachedModel;
  if (process.env.OTP_MODEL) { cachedModel = process.env.OTP_MODEL; return cachedModel; }
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (r.ok) {
      const d = await r.json();
      const ids = (d.data || []).map(m => m.id);
      const haiku = ids.find(i => /haiku/i.test(i));
      const sonnet = ids.find(i => /sonnet/i.test(i));
      cachedModel = haiku || sonnet || ids[0];
      if (cachedModel) return cachedModel;
    }
  } catch (e) { /* fall through */ }
  cachedModel = FALLBACK_MODELS[0];
  return cachedModel;
}

const SCHEMA = {
  name: 'plan',
  description: 'A structured plan derived from the user request.',
  input_schema: {
    type: 'object',
    properties: {
      stops: {
        type: 'array',
        description: 'One entry per place they want to end up at, in order. "food then drinks" is two stops.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['eat', 'drink', 'coffee', 'outdoors', 'culture', 'shop', 'any'] },
            cuisines: { type: 'array', items: { type: 'string' },
              description: 'Cuisine words if named, e.g. Japanese, Italian, Thai.' },
            maxBand: { type: 'string', enum: ['£', '££', '£££', '££££'],
              description: 'Cheapest acceptable ceiling. "cheap" is £, "nice" or "special" is £££.' },
            tags: { type: 'array', items: { type: 'string', enum: [
              'date-night', 'special', 'cheap', 'matcha', 'listening', 'late',
              'livemusic', 'whimsy', 'green', 'summer', 'free', 'culture',
              'shopcafe', 'markets', 'dated'] } },
            label: { type: 'string', description: 'Two or three words for this stop, e.g. "dinner", "cheap drinks".' },
          },
          required: ['kind'],
        },
      },
      locations: { type: 'array', items: { type: 'string' },
        description: 'Areas, neighbourhoods, stations or postcodes mentioned, verbatim. e.g. ["Peckham","Northolt"]' },
      venues: { type: 'array', items: { type: 'string' },
        description: 'Specific named venues mentioned - a restaurant, bar or cafe - as opposed to an area. e.g. ["Zephyr"]. Always include one if the user names a place they have been or are going to.' },
      anchorIsVenue: { type: 'boolean',
        description: 'True when the search should be centred on a named venue rather than an area, e.g. "somewhere after dinner at X".' },
      between: { type: 'boolean',
        description: 'True when they want somewhere between the named locations.' },
      useMyLocation: { type: 'boolean', description: 'True for "near me", "close by", "around here".' },
      radiusKm: { type: 'number', description: 'Only if they state a distance or say "walking distance".' },
      party: { type: 'integer', description: 'How many people, if stated. "for two" is 2.' },
      when: { type: 'string', description: 'Any timing mentioned, verbatim, e.g. "tomorrow", "tonight".' },
      reply: { type: 'string',
        description: 'One short sentence, under 15 words, saying what you looked for. No greeting, no filler.' },
    },
    required: ['stops', 'reply'],
  },
};

const SYSTEM = `You convert requests about going out in London into a structured query.
You never choose venues; a local database does that. Extract only what was asked for.

Rules:
- "drinks" is kind=drink. "food"/"dinner"/"eat" is eat. "coffee"/"matcha" is coffee.
- "food then drinks" is two stops in that order.
- "cheap", "budget", "a tenner" -> maxBand "£". "nice", "fancy", "special" -> "£££".
- "date", "for two", "romantic" -> tags ["date-night"] and party 2.
- Areas and stations go in locations verbatim, even if misspelled. Do not invent places.
- A named restaurant, bar or cafe goes in venues, not locations, and sets anchorIsVenue true.
  "just ate at Zephyr, drinks after" -> venues ["Zephyr"], anchorIsVenue true, one drink stop.
- Do not set useMyLocation when a venue or area anchors the request.
- "in the middle", "between us", "halfway" -> between=true.
- If nothing narrows it, return one stop with kind "any".
- Never put a cuisine in locations, or a place name in cuisines.`;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let q = '';
  try { q = (JSON.parse(event.body || '{}').q || '').toString().slice(0, 400); } catch (e) {}
  if (!q.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'empty' }) };

  const key = findKey();
  if (!key)
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_key',
      detail: 'No API key found in the environment.' }) };

  try {
    const model = await pickModel(key);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: SYSTEM,
        tools: [SCHEMA],
        tool_choice: { type: 'tool', name: 'plan' },
        messages: [{ role: 'user', content: q }],
      }),
    });
    const d = await r.json();
    if (!r.ok)
      return { statusCode: 200, headers, body: JSON.stringify({
        error: 'api', status: r.status, detail: (d.error && d.error.message) || '', model }) };
    const block = (d.content || []).find(c => c.type === 'tool_use');
    if (!block)
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_plan', model }) };
    return { statusCode: 200, headers, body: JSON.stringify({ plan: block.input, model }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'exception', detail: String(e) }) };
  }
};
