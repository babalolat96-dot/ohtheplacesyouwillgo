// The events scout, NATIVE to the site. Runs on Netlify's own scheduler —
// no cloud sessions, no files to paste, nothing for Tope to do after deploy.
// Every Thursday morning it reads orixa.fm's London listings, keeps what
// fits the taste lane (afro house, gqom, 3-step, afrotech, amapiano,
// Soulection-adjacent, Carnival-and-kin), geocodes the venues, and writes
// the fresh horizon straight into the same Blobs store the app reads.
//
// v2 handler (Blobs needs it) + config.schedule (Netlify cron, UTC).
// Netlify functions get ~10s: everything here runs against a hard internal
// deadline, and a slow week degrades to "write what we have" — the previous
// feed is only replaced on a successful pass, never blanked by a timeout.

import { getStore } from '@netlify/blobs';

// Wednesdays 14:30 London. Netlify cron is UTC and does NOT follow the
// clocks changing: 13:30 UTC is 2:30pm in summer, 1:30pm in winter.
export const config = { schedule: '30 13 * * 3' };

const KEY = 'events-v1';
const LANE = /afro|amapiano|gqom|3.?step|soulection|r&b|rnb|\bsoul\b|piano|carnival|afrobeat|dancehall|bashment/i;

const MODEL_KEYS = ['ANTHROPIC_API_KEY', 'OTP_MODEL_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY', 'BABLOAPI', 'API_KEY'];
const G_KEYS = ['GOOGLE_PLACES_KEY', 'GOOGLE_PLACES_API_KEY', 'GOOGLE_API_KEY', 'PLACES_KEY'];
const envKey = names => {
  for (const n of names) { const v = process.env[n]; if (v && v.trim()) return v.trim(); }
  return null;
};
/* same trap as enrich/editorial: "API_KEY" may hold something that is not an
   Anthropic key, and posting it returns 401 while the rest of the site works */
const looksAnthropic = v => /^sk-ant-/.test(String(v || '').trim());
const modelKey = () => {
  for (const n of MODEL_KEYS) { const v = process.env[n]; if (v && looksAnthropic(v)) return v.trim(); }
  const found = Object.values(process.env).map(v => String(v || '').trim()).find(looksAnthropic);
  if (found) return found;
  for (const n of MODEL_KEYS) { const v = process.env[n]; if (v && v.trim()) return v.trim(); }
  return null;
};
const googleKey = () => envKey(G_KEYS) ||
  Object.values(process.env).map(v => String(v || '').trim())
    .find(v => /^AIza[0-9A-Za-z_-]{20,}$/.test(v)) || null;

async function fetchText(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'otp-scout/1.0 (personal London map)' } });
    return r.ok ? await r.text() : '';
  } catch (e) { return ''; }
  finally { clearTimeout(t); }
}

// keep the links, lose the markup: "<a href=X>Y</a>" → "Y [href:X]"
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, ' $2 [href:$1] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').slice(0, 60000);
}

const SCHEMA = {
  name: 'events',
  description: 'London events extracted from the listing text.',
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            artists: { type: 'array', items: { type: 'string' } },
            venue: { type: 'string' },
            day: { type: 'string', description: 'as written, e.g. "FRI 21 AUG"' },
            time: { type: 'string', description: '24h as written, e.g. "23:00"' },
            url: { type: 'string', description: 'the [href:...] next to the event, absolute' },
            genres: { type: 'array', items: { type: 'string' } },
            why: { type: 'string', description: 'one honest line on the taste fit' },
            src: { type: 'string', description: 'the SOURCE label the event appeared under' },
          },
          required: ['title', 'venue', 'day'],
        },
      },
    },
    required: ['events'],
  },
};

async function extract(text, today) {
  const key = modelKey();
  if (!key) return { error: 'no_model_key', events: [] };
  let model = process.env.OTP_MODEL || null;
  if (!model) {
    try {
      const r = await fetchJson('https://api.anthropic.com/v1/models?limit=100',
        { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, 3000);
      const ids = ((r && r.data) || []).map(m => m.id);
      model = ids.find(i => /haiku/i.test(i)) || ids.find(i => /sonnet/i.test(i)) || ids[0];
    } catch (e) {}
  }
  if (!model) model = 'claude-haiku-4-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 2500,
      system: 'You extract London event listings from page text, verbatim — never invent an event, ' +
        'a date, or a URL. Keep ONLY events whose genres or lineup fit this taste: afro house, gqom, ' +
        '3-step, afrotech, amapiano, afrobeats, dancehall, Soulection-style soul/R&B selections, and ' +
        'Black-London-culture festivals or day parties. Generic techno, trance, hard house or indie do ' +
        'NOT fit unless the lineup clearly overlaps. Fewer certain events beats a padded list.',
      tools: [SCHEMA], tool_choice: { type: 'tool', name: 'events' },
      messages: [{ role: 'user', content:
        'Today is ' + today + '. Listing text (links appear as [href:...] after each event):\n\n' + text }],
    }),
  });
  if (!r.ok) return { error: 'model_' + r.status, events: [] };
  const d = await r.json();
  const block = (d.content || []).find(c => c.type === 'tool_use');
  return { events: (block && block.input && block.input.events) || [], model };
}

async function fetchJson(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

// last Sunday of March .. last Sunday of October, roughly: London is +01:00
function bst(y, m, day) {
  if (m > 3 && m < 10) return true;
  if (m < 3 || m > 10) return false;
  const last = new Date(Date.UTC(y, m, 0));                 // last day of month m (1-based)
  const lastSun = last.getUTCDate() - last.getUTCDay();
  return m === 3 ? day > lastSun : day <= lastSun;          // simple, right to the day
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function toISO(dayText, timeText, now) {
  const m = String(dayText || '').toLowerCase().match(/(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (!m) return null;
  const day = +m[1], mon = MONTHS[m[2]];
  let year = now.getUTCFullYear();
  if (mon < now.getUTCMonth() + 1 - 6) year++;              // December reading a January date
  const t = String(timeText || '20:00').match(/(\d{1,2})[:.](\d{2})/);
  const hh = t ? +t[1] : 20, mm = t ? +t[2] : 0;
  const off = bst(year, mon, day) ? '+01:00' : '+00:00';
  const p = n => String(n).padStart(2, '0');
  return `${year}-${p(mon)}-${p(day)}T${p(hh)}:${p(mm)}:00${off}`;
}

async function geocode(venue, gkey) {
  if (!gkey || !venue) return null;
  const d = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': gkey,
      'X-Goog-FieldMask': 'places.location,places.shortFormattedAddress',
    },
    body: JSON.stringify({
      textQuery: venue + ', London', maxResultCount: 1, languageCode: 'en-GB', regionCode: 'GB',
      locationBias: { rectangle: { low: { latitude: 51.25, longitude: -0.56 },
                                   high: { latitude: 51.72, longitude: 0.34 } } },
    }),
  }, 2500);
  const p = d && d.places && d.places[0];
  if (!p || !p.location) return null;
  const { latitude: lat, longitude: lng } = p.location;
  if (!(lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) return null;
  return { lat, lng, addr: p.shortFormattedAddress || null };
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);

export default async () => {
  const started = Date.now();
  const deadline = started + 8200;
  const left = () => deadline - Date.now();
  const now = new Date();
  const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' } });

  // 1. read the sources: orixa is the floor, never the ceiling. The learned
  // list (SRCKEY) grows from what Tope feeds the app — every event post he
  // pastes teaches a promoter, and the scout reads them all from then on.
  const store = getStore({ name: 'otp-bank', consistency: 'strong' });
  let learned = [];
  try {
    const v = await store.get('evsources-v1', { type: 'json' });
    learned = (Array.isArray(v) ? v : [])
      .filter(s => s && /^https:\/\//.test(String(s.url || '')))
      .slice(0, 4);                                   // budget: a 10s function
  } catch (e) {}
  const fetches = [
    fetchText('https://orixa.fm/city/london', 4000).then(h => ({ label: 'orixa', h })),
    fetchText('https://orixa.fm/city/london/2', 4000).then(h => ({ label: 'orixa', h })),
    ...learned.map(s => fetchText(s.url, 4000)
      .then(h => ({ label: String(s.label || new URL(s.url).hostname).slice(0, 30), h }))),
  ];
  const pages = await Promise.all(fetches);
  const text = pages.filter(p => p.h)
    .map(p => 'SOURCE: ' + p.label + '\n' + stripHtml(p.h)).join('\n\n');
  if (text.length < 500) return J({ ok: false, error: 'sources_unreachable', kept: 0 });

  // 2. model-extract, taste-filtered at the source
  if (left() < 3500) return J({ ok: false, error: 'no_time_for_model', kept: 0 });
  const ex = await extract(text, now.toDateString());
  if (ex.error) return J({ ok: false, error: ex.error, kept: 0 });

  // belt and braces on the lane, then dates
  const horizon = now.getTime() + 21 * 86400e3;
  let events = ex.events
    .filter(e => LANE.test([e.title, (e.genres || []).join(' '), e.why, (e.artists || []).join(' ')].join(' ')))
    .map(e => ({ ...e, start: toISO(e.day, e.time, now) }))
    .filter(e => e.start && Date.parse(e.start) > now.getTime() - 6 * 3600e3
                        && Date.parse(e.start) < horizon)
    .slice(0, 25);

  // 3. geocode what time allows, in parallel
  const gkey = googleKey();
  if (gkey && left() > 1500) {
    await Promise.all(events.map(async e => {
      const g = await geocode(e.venue, gkey);
      if (g) { e.lat = g.lat; e.lng = g.lng; e.addr = g.addr; }
    }));
  }

  // 4. write the fresh horizon — same shape events.mjs serves
  const cleaned = events.map(e => ({
    id: slug(e.title) + '-' + String(e.start).slice(0, 10),
    title: String(e.title).slice(0, 160),
    artists: (e.artists || []).slice(0, 12).map(a => String(a).slice(0, 60)),
    venue: e.venue ? String(e.venue).slice(0, 100) : null,
    addr: e.addr || null, area: null,
    lat: Number.isFinite(e.lat) ? e.lat : null, lng: Number.isFinite(e.lng) ? e.lng : null,
    start: e.start, end: null,
    url: /^https:\/\//.test(String(e.url || '')) ? String(e.url).slice(0, 300)
       : /^\//.test(String(e.url || '')) ? 'https://orixa.fm' + String(e.url).slice(0, 290) : null,
    src: e.src ? String(e.src).toLowerCase().slice(0, 30) : 'orixa',
    genres: (e.genres || []).slice(0, 6).map(g => String(g).toLowerCase().slice(0, 30)),
    why: e.why ? String(e.why).slice(0, 240) : null,
    fetchedAt: Date.now(),
  }));
  if (!cleaned.length) return J({ ok: false, error: 'nothing_in_the_lane', extracted: ex.events.length, kept: 0 });

  await store.setJSON(KEY, cleaned);
  return J({ ok: true, extracted: ex.events.length, kept: cleaned.length,
    geocoded: cleaned.filter(e => e.lat).length, model: ex.model, ms: Date.now() - started });
};
