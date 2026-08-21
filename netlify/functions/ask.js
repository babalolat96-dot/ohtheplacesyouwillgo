// Turns a sentence into a structured query. It never sees the venue data:
// the page does the searching. The API key stays server side.

const KEY_NAMES = [
  'ANTHROPIC_API_KEY', 'OTP_MODEL_KEY', 'CLAUDE_API_KEY',
  'ANTHROPIC_KEY', 'BABLOAPI', 'API_KEY',
];

function findKey() {
  // A name can lie: netlify dev injects its own ANTHROPIC_API_KEY (a gateway
  // token, not an Anthropic key) which 401s. Prefer whatever actually LOOKS
  // like an Anthropic key, wherever it lives; named-but-odd only as last resort.
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && /^sk-ant-/.test(v.trim())) return v.trim();
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && /^sk-ant-/.test(v.trim())) return v.trim();
  }
  for (const n of KEY_NAMES) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
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
      eventsAsk: { type: 'boolean',
        description: 'True when what they want is an EVENT — something happening at a time, with a lineup or a crowd — rather than a venue to walk into. Judge the intent, not the words. "I want to dance on Friday", "somewhere to hear proper amapiano", "what should I do Saturday night", "is there anything on", "I need a rave" are all true even though none of them say the word "event". "A quiet drink", "dinner somewhere nice", "a coffee near me" are false.' },
      eventsDay: { type: 'string',
        description: 'If eventsAsk and they named a day or window, give it verbatim: "friday", "tonight", "this weekend", "next weekend". Empty if they did not.' },
      wantsAfter: { type: 'boolean',
        description: 'True when they are planning an occasion rather than looking for one place right now: a date, a night out, "what can I do after", "where should I take her". False for an immediate single need like "coffee near me" or "I want a drink now".' },
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
- Never put a cuisine in locations, or a place name in cuisines.
- WANTING TO DANCE IS AN EVENTS QUESTION. So is wanting to hear a genre, see a
  DJ, or "go out out". A club night is not a venue you wander into — it is a
  thing happening on a date. Set eventsAsk on the intent, never on the vocabulary.
- wantsAfter is about intent, not wording. Set it true for anything being planned:
  "somewhere in Soho for the date", "where can I take her", "going to the park,
  what after", "night out in Dalston". Set it false for an immediate single need:
  "coffee near me", "I want a drink now", "closest pub".`;

/* A follow-up can be a question ABOUT the options on screen — "which one for a
   first date?", "the second one", "which is cosiest?" — rather than a new
   search. Then the answer is a ranked pick among those names, nothing else. */
const PICK = {
  name: 'pick',
  description: 'Answer a question about the options currently shown, by ranking or choosing among them.',
  input_schema: {
    type: 'object',
    properties: {
      names: { type: 'array', items: { type: 'string' },
        description: 'The shown option names, best answer first. Only names from the list, verbatim. One name for "the second one"; a ranked list for a comparison.' },
      reply: { type: 'string',
        description: 'One or two short sentences answering the question in plain words. If you cannot honestly judge from what you know, say so plainly — never bluff.' },
    },
    required: ['names', 'reply'],
  },
};

/* Some follow-ups are neither a request nor a pick — they are the user
   TALKING BACK: a challenge, a doubt, a why. Those deserve words, not a
   fresh list dressed up as an answer. */
const SAY = {
  name: 'say',
  description: 'A conversational reply about the answer already on screen, when neither a new plan nor a pick fits — a challenge, a doubt, a "why".',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string',
        description: 'Two or three plain sentences, honest and specific, using only the conversation and the options list as facts. If they doubt something the options disprove, point at the options by name. If they doubt something you cannot verify, concede what you do not know.' },
    },
    required: ['reply'],
  },
};

const SAYRULES = `If the follow-up is not a request at all — a challenge
("that's impossible", "are you sure?"), a doubt, or a question about WHY the
answer looks the way it does — use the say tool and answer it honestly from
the conversation and the options on screen. Example: told "my bank has
nothing in Dalston? impossible" while the options list shows Dalston places,
name two of them and explain what the earlier reply actually meant. Never
respond to a complaint with a new search.
Also use say when the request is genuinely AMBIGUOUS — two readings that lead
to different answers ("somewhere fun" with no other signal, a place name that
is also an area). Ask ONE short clarifying question, the way a person would,
instead of guessing silently.`;

const CHATRULES = `Not every message is a search. Use the plan tool ONLY when
they are asking to FIND places or events. For anything else — a question you
can answer in words, a remark, or something this app cannot do yet (bookings,
weather, exact prices) — use the say tool: brief, honest, plain words, and
say clearly when something is beyond you. Never turn a question into a list
of places nobody asked for.
NEVER deny what this app CAN do. It can: search live artist gig listings
(tell them to ask e.g. "when is Supa D playing?"), give live TfL journey
times ("how long to get to X?") and line status ("is the victoria line
down?"), build and keep multi-stop plans with a backward clock, follow DJs
and promoters for the weekly scout, import places from Instagram/TikTok
links and photos, and answer questions about any place from its own
knowledge. If their message looks like a mistyped attempt at one of those,
point them to the working phrasing instead of refusing.`;

const PICKRULES = `The user is LOOKING AT a list of options (supplied as JSON).
If the follow-up is a question about those options — which to pick, how they
compare, "the first one", "which is best for X" — answer with the pick tool:
names from the list verbatim, best first, and a short honest reply. Never
invent facts about a venue; if you do not know, say so in the reply and keep
the order unchanged. If the follow-up is instead a new or changed REQUEST
(different kind of place, new area, new constraints), use the plan tool.`;

/* A question ABOUT one venue ("how many people is it good for?") wants an
   ANSWER, not a plan. The page sends everything the app knows about the place
   — the writer's words, the review-read understanding, the venue-site read,
   hours — and the model answers from that knowledge alone. */
const ANSWER = {
  name: 'answer',
  description: 'A direct answer about one venue, from the supplied knowledge only.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string',
        description: 'One to three short sentences answering the question. If the knowledge does not contain the answer, say that plainly and give the nearest fact it DOES contain. Never invent hours, prices, capacity or policies.' },
      grounded: { type: 'boolean',
        description: 'True only when the reply is supported by the supplied knowledge rather than general assumption.' },
    },
    required: ['reply', 'grounded'],
  },
};

const ABOUTRULES = `You answer ONE question about ONE London venue, using ONLY
the knowledge supplied as JSON ("about") and what it directly implies. If the
knowledge does not contain the answer, say so plainly and offer the nearest
useful fact it DOES contain. Never invent hours, prices, capacity, bookings or
policies. Answer in plain words, no greeting, no filler.`;

/* A photo attached to the chat: say what it shows — venue names, an event,
   a list — or ask the ONE question needed. The page acts on the names. */
const SEEN = {
  name: 'seen',
  description: 'What an attached photo shows, for a London going-out app.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['flyer', 'place', 'menu', 'list', 'screenshot', 'other', 'unreadable'],
        description: 'What the photo is.' },
      venues: { type: 'array', items: { type: 'string' },
        description: 'Venue names actually visible in the image, verbatim. Empty if none are readable.' },
      event: { type: 'object', properties: {
          title: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' } },
        description: 'If it is an event flyer: the event name and any date/time printed on it, verbatim.' },
      reply: { type: 'string',
        description: 'One or two short sentences: what you can see and what you did with it — or, if you cannot make enough out, ONE specific question that would unlock it. Never pretend to read what is not legible.' },
    },
    required: ['kind', 'reply'],
  },
};

const SEENRULES = `You are reading a photo someone attached in a London
going-out app — usually an event flyer, a venue storefront, a menu, or a
screenshot of a list of places. Report ONLY what is actually legible in the
image: names verbatim, dates verbatim. If it is too unclear to act on, set
kind "unreadable" and make reply the one specific question that would help
("Whereabouts was this taken?", "What's the name on the front?"). Never
invent a name or a date.`;

/* When a place card is open on screen, that place is the subject of anything
   said with "it", "here", "this place" — the map context the user acts in. */
const FOCUSRULES = `The user has a place OPEN ON SCREEN right now, supplied as JSON as "focus".
Anything said with "it", "its", "here", "there", "this place" — or with no
other subject at all — is about that place:
- "what's good around it" / "where to after" -> venues [that name], anchorIsVenue true, plus the stop they asked for.
- "is it open late" / "when does it close" -> venues [that name], anchorIsVenue true, one stop kind "any".
- "how do I get there" -> venues [that name], anchorIsVenue true.
Never swap the focus place for somewhere they did not name. If they clearly
name a DIFFERENT place or area, that wins and focus is ignored.`;

const MERGE = `This message is a FOLLOW-UP to an earlier request, supplied as JSON.
Return the COMPLETE merged query: keep every field from the earlier request that
the follow-up does not change, and change only what it asks to change.
- "cheaper" keeps the same stops and locations, lowers maxBand to "£".
- "what about soho" keeps the stops, replaces locations with ["Soho"].
- "drinks instead" swaps the stop kind, keeps everything else.
- "there will be 6 of us" only changes party.
- A completely new request (new kind AND new area, unrelated to the earlier one)
  replaces it outright rather than merging.
Never carry the earlier "anchor" venue into venues - it is where they already
looked, not something they named now.`;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let q = '', prev = null, options = null, conv = null, focus = null, about = null, image = null;
  try {
    const body = JSON.parse(event.body || '{}');
    q = (body.q || '').toString().slice(0, 400);
    // a follow-up carries the previous query as context, already compacted
    if (body.prev && typeof body.prev === 'object') {
      const s = JSON.stringify(body.prev);
      if (s.length <= 2000) prev = s;
    }
    // what is on screen: names only, so "which one" has a referent
    if (Array.isArray(body.options) && body.options.length) {
      options = body.options.slice(0, 12).map(o => ({
        name: String(o.name || '').slice(0, 80),
        kind: String(o.kind || '').slice(0, 20),
        area: String(o.area || '').slice(0, 40),
      })).filter(o => o.name);
      if (!options.length) options = null;
    }
    // the last few conversational turns, for pronouns and drift
    if (Array.isArray(body.conv) && body.conv.length) {
      conv = body.conv.slice(-8).map(t => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        text: String(t.text || '').slice(0, 200),
      }));
    }
    // the place card open on screen: the subject of "it" and "here"
    if (body.focus && typeof body.focus === 'object' && body.focus.name) {
      focus = { name: String(body.focus.name).slice(0, 80),
        kind: String(body.focus.kind || '').slice(0, 20),
        area: String(body.focus.area || '').slice(0, 40) };
    }
    // everything the app knows about one place, for a direct answer
    if (body.about && typeof body.about === 'object' && body.about.name) {
      const s = JSON.stringify(body.about);
      if (s.length <= 6000) about = s;
    }
    // an attached photo, already shrunk client-side
    if (body.image && typeof body.image === 'object' && typeof body.image.data === 'string') {
      const mt = String(body.image.media_type || 'image/jpeg');
      if (/^image\/(jpeg|png|webp|gif)$/.test(mt) && body.image.data.length <= 2000000)
        image = { data: body.image.data, media_type: mt };
    }
  } catch (e) {}
  if (!q.trim() && !image) return { statusCode: 400, headers, body: JSON.stringify({ error: 'empty' }) };

  const key = findKey();
  if (!key)
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_key',
      detail: 'No API key found in the environment.' }) };

  try {
    const model = await pickModel(key);

    /* photo-mode: read the attached image and report what is actually there */
    if (image) {
      const ri = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01',
          'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 500,
          system: SEENRULES,
          tools: [SEEN],
          tool_choice: { type: 'tool', name: 'seen' },
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
            { type: 'text', text:
              (conv && conv.length
                ? 'Conversation so far:\n' + conv.map(t => (t.role === 'user' ? 'They said: ' : 'You showed: ') + t.text).join('\n') + '\n\n'
                : '')
              + (q.trim() ? 'They attached this photo and said: ' + q : 'They attached this photo. What is it?') } ] }],
        }),
      });
      const di = await ri.json();
      if (!ri.ok)
        return { statusCode: 200, headers, body: JSON.stringify({
          error: 'api', status: ri.status, detail: (di.error && di.error.message) || '', model }) };
      const bi = (di.content || []).find(c => c.type === 'tool_use');
      if (!bi)
        return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_read', model }) };
      return { statusCode: 200, headers, body: JSON.stringify({ seen: bi.input, model }) };
    }

    /* about-mode: a question about one place gets an answer from the app's
       own knowledge — a completely different contract from planning */
    if (about) {
      const r0 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01',
          'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 400,
          system: ABOUTRULES,
          tools: [ANSWER],
          tool_choice: { type: 'tool', name: 'answer' },
          messages: [{ role: 'user', content:
            (conv && conv.length
              ? 'Conversation so far:\n' + conv.map(t => (t.role === 'user' ? 'They said: ' : 'You showed: ') + t.text).join('\n') + '\n\n'
              : '')
            + 'Everything the app knows about the place (JSON): ' + about
            + '\nQuestion: ' + q }],
        }),
      });
      const d0 = await r0.json();
      if (!r0.ok)
        return { statusCode: 200, headers, body: JSON.stringify({
          error: 'api', status: r0.status, detail: (d0.error && d0.error.message) || '', model }) };
      const b0 = (d0.content || []).find(c => c.type === 'tool_use');
      if (!b0)
        return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_answer', model }) };
      return { statusCode: 200, headers, body: JSON.stringify({ answer: b0.input, model }) };
    }

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
        system: (prev
          ? SYSTEM + '\n\n' + MERGE + (options ? '\n\n' + PICKRULES : '') + '\n\n' + SAYRULES
          : SYSTEM + '\n\n' + CHATRULES) + (focus ? '\n\n' + FOCUSRULES : ''),
        // the model chooses how to answer: a plan when they want places, a
        // pick when they're choosing among options, or just words — a real
        // conversation is allowed to simply talk back
        tools: prev ? [SCHEMA, ...(options ? [PICK] : []), SAY] : [SCHEMA, SAY],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: (prev || focus || (conv && conv.length))
          ? (conv && conv.length
              ? 'Conversation so far:\n' + conv.map(t => (t.role === 'user' ? 'They said: ' : 'You showed: ') + t.text).join('\n') + '\n\n'
              : '')
            + (prev ? 'Earlier request (JSON): ' + prev + '\n' : '')
            + (options ? 'Options on screen (JSON): ' + JSON.stringify(options) + '\n' : '')
            + (focus ? 'Place open on screen (JSON): ' + JSON.stringify(focus) + '\n' : '')
            + (prev ? 'Follow-up: ' : 'Request: ') + q
          : q }],
      }),
    });
    const d = await r.json();
    if (!r.ok)
      return { statusCode: 200, headers, body: JSON.stringify({
        error: 'api', status: r.status, detail: (d.error && d.error.message) || '', model }) };
    const block = (d.content || []).find(c => c.type === 'tool_use');
    if (!block)
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_plan', model }) };
    if (block.name === 'pick')
      return { statusCode: 200, headers, body: JSON.stringify({ pick: block.input, model }) };
    if (block.name === 'say')
      return { statusCode: 200, headers, body: JSON.stringify({ say: block.input, model }) };
    return { statusCode: 200, headers, body: JSON.stringify({ plan: block.input, model }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'exception', detail: String(e) }) };
  }
};
