// The editorial layer: what is WRITTEN about a place, not just rated.
//
// enrich.mjs distils the review corpus — hundreds of ordinary voices. This
// reads the other half of the record: the venue's own words (its site, its
// menu, its about page) and whatever press or blog coverage exists. Then it
// names the thing neither source can state alone — the GAP between what a
// place promises and what people actually experience. That gap is the most
// useful sentence you can put on a card.
//
// Works with no new API key: the venue's own website comes from Google Places
// (websiteUri), which the site already pays for. If a web-search key is
// present (BRAVE_SEARCH_KEY, or GOOGLE_CSE_KEY + GOOGLE_CSE_CX) it also reads
// press coverage; without one it says so honestly rather than pretending.
//
// v2 handler (Blobs) + schedule. Cursor-driven so it converges and stops.

import { getStore } from '@netlify/blobs';

/* NOT scheduled. Netlify blocks HTTP access to scheduled functions with a
   403, and the app must be able to READ this over HTTP. cron.mjs is the
   scheduled function and it pokes this one. Do not add a schedule here. */

const KEY = 'editorial-v1';
const CKEY = 'editorial-cursor-v1';
const PER_RUN = 3;                 // page fetches are slow; three is the honest max
const STALE_DAYS = 180;

const MODEL_KEYS = ['ANTHROPIC_API_KEY','OTP_MODEL_KEY','CLAUDE_API_KEY','ANTHROPIC_KEY','BABLOAPI','API_KEY'];
const G_KEYS = ['GOOGLE_PLACES_KEY','GOOGLE_PLACES_API_KEY','GOOGLE_API_KEY','PLACES_KEY'];
const envKey = names => {
  for (const n of names) { const v = process.env[n]; if (v && v.trim()) return v.trim(); }
  return null;
};
/* An Anthropic key must LOOK like one. "API_KEY" is a dangerously generic name
   to trust blindly: taking whatever sits there and posting it to Anthropic is
   how every model call came back 401 while the rest of the site worked fine
   (suggest.js pattern-scans, these did not). Named vars first, but only if the
   value is plausible; then scan the whole environment for an sk-ant- key. */
const looksAnthropic = v => /^sk-ant-/.test(String(v || '').trim());
const modelKey = () => {
  for (const n of MODEL_KEYS) {
    const v = process.env[n];
    if (v && looksAnthropic(v)) return v.trim();
  }
  const found = Object.values(process.env).map(v => String(v || '').trim()).find(looksAnthropic);
  if (found) return found;
  // last resort: an unrecognised format under an explicit name, so a
  // self-hosted proxy key still works — but named vars only, never a scan
  for (const n of MODEL_KEYS) { const v = process.env[n]; if (v && v.trim()) return v.trim(); }
  return null;
};
const googleKey = () => envKey(G_KEYS) ||
  Object.values(process.env).map(v => String(v||'').trim())
    .find(v => /^AIza[0-9A-Za-z_-]{20,}$/.test(v)) || null;

const slug = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,80);
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function grab(url, ms, json) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; otp-reader/1.0)',
                 'Accept': json ? 'application/json' : 'text/html,application/xhtml+xml' } });
    if (!r.ok) return null;
    return json ? await r.json() : await r.text();
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}
async function post(url, headers, body, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

/* readable text out of a page, links kept where they might be an about/menu */
function textOf(html, limit) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ').trim().slice(0, limit || 6000);
}
function subPages(html, base) {
  const out = [];
  const re = /href="([^"#?]{2,120})"/gi;
  let m;
  while ((m = re.exec(String(html||''))) && out.length < 2) {
    const h = m[1];
    if (!/about|story|menu|food|drink|kitchen|philosophy/i.test(h)) continue;
    try { out.push(new URL(h, base).toString()); } catch (e) {}
  }
  return [...new Set(out)];
}

/* press coverage. Only if a search key exists — and social/aggregator noise
   is excluded, because a TripAdvisor page is not editorial. */
const JUNK = /instagram\.com|facebook\.com|tiktok\.com|twitter\.com|x\.com|tripadvisor|yelp|opentable|thefork|deliveroo|ubereats|justeat|booking\.com|quandoo|resy|sevenrooms|google\.|youtube\.com|reddit\.com|pinterest/i;
async function press(name, area) {
  const q = `"${name}" ${area || 'London'} review`;
  const brave = envKey(['BRAVE_SEARCH_KEY','BRAVE_API_KEY','BRAVE_KEY']);
  const cseKey = envKey(['GOOGLE_CSE_KEY','CSE_KEY']);
  const cseCx = envKey(['GOOGLE_CSE_CX','CSE_CX']);
  let hits = [];
  if (brave) {
    const d = await grab('https://api.search.brave.com/res/v1/web/search?count=6&q=' +
      encodeURIComponent(q), 2500, true);
    hits = (((d||{}).web||{}).results||[]).map(r => ({ title: r.title, url: r.url,
      snippet: r.description || '' }));
  } else if (cseKey && cseCx) {
    const d = await grab('https://www.googleapis.com/customsearch/v1?num=6&key=' +
      encodeURIComponent(cseKey) + '&cx=' + encodeURIComponent(cseCx) +
      '&q=' + encodeURIComponent(q), 2500, true);
    hits = ((d||{}).items||[]).map(r => ({ title: r.title, url: r.link, snippet: r.snippet || '' }));
  } else return { none: 'no_search_key', hits: [] };
  return { hits: hits.filter(h => h.url && !JUNK.test(h.url)).slice(0, 3) };
}

const SCHEMA = {
  name: 'editorial',
  input_schema: {
    type: 'object',
    properties: {
      claims: { type: 'string', description: "What the place says about ITSELF, in your own words, from its own site. What it is trying to be. Null if its site said nothing useful." },
      story: { type: 'string', description: 'Who is behind it and where it came from, if the evidence states it — chef, family, previous site, year opened. Never guess. Null if unknown.' },
      pressSays: { type: 'string', description: 'What published coverage says, if any was given. Attribute in the text ("Time Out called it…"). Null if no press evidence.' },
      gap: { type: 'string', description: "The honest gap between the promise and the lived experience: where the venue's own framing and the reviewers' experience diverge. This is the most valuable line here. Null if they broadly agree." },
      signature: { type: 'array', items: { type: 'string' }, description: 'The dishes or drinks the place is actually known for, named in the evidence. Empty if none.' },
      sources: { type: 'array', items: { type: 'object',
        properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title','url'] },
        description: 'Every page this reading is based on.' },
      confidence: { type: 'string', enum: ['high','medium','low'] },
    },
    required: ['confidence','sources'],
  },
};

const SYSTEM = `You read what a venue publishes about itself and what the press writes about it, and you report it straight.

Rules:
- Only state what the evidence says. No inference about awards, chefs, history or provenance that is not written down. Null beats a guess.
- Plain British English, a friend's register, never marketing copy. Banned: hidden gem, must-visit, vibrant, nestled, culinary journey, elevated, iconic, destination.
- A venue's own site is a sales pitch; treat it as a claim, not a fact. Reviewer experience, where given, outranks it.
- The "gap" field is the point of this exercise: if a place calls itself a relaxed neighbourhood spot and diners consistently describe a two-hour queue and a hard sell on wine, say exactly that. If promise and experience broadly agree, say so by returning null rather than inventing tension.
- Attribute press claims to whoever published them.`;

let cachedModel = null;
/* the models list needs the api key as a header, so it cannot use grab() */
async function pickModel(mkey) {
  if (cachedModel) return cachedModel;
  if (process.env.OTP_MODEL) return (cachedModel = process.env.OTP_MODEL);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { signal: ac.signal,
      headers: { 'x-api-key': mkey, 'anthropic-version': '2023-06-01' } });
    if (r.ok) {
      const ids = ((await r.json()).data || []).map(m => m.id);
      cachedModel = ids.find(i => /haiku/i.test(i)) || ids.find(i => /sonnet/i.test(i)) || ids[0];
    }
  } catch (e) {}
  finally { clearTimeout(t); }
  return (cachedModel = cachedModel || 'claude-haiku-4-5');
}

async function distil(place, own, pressBits, reviewLine, mkey) {
  const model = await pickModel(mkey);

  const evidence = [
    `VENUE: ${place.n}${place.area ? ', ' + place.area : ''}`,
    own.url ? `ITS OWN WEBSITE (${own.url}):\n${own.text}` : 'ITS OWN WEBSITE: not found.',
    pressBits.length
      ? 'PUBLISHED COVERAGE:\n' + pressBits.map(b =>
          `- ${b.title} (${b.url})\n  ${b.text}`).join('\n')
      : 'PUBLISHED COVERAGE: none available to this reading.',
    reviewLine ? `WHAT REVIEWERS SAY (already distilled): ${reviewLine}` : null,
    place.own ? `WHY IT IS ON THIS MAP (the person who recommended it): ${place.own}` : null,
  ].filter(Boolean).join('\n\n');

  const d = await post('https://api.anthropic.com/v1/messages',
    { 'x-api-key': mkey, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 1100, system: SYSTEM, tools: [SCHEMA],
      tool_choice: { type: 'tool', name: 'editorial' },
      messages: [{ role: 'user', content: evidence }] }, 9000);
  if (!d) return { error: 'model_failed' };
  const block = (d.content || []).find(c => c.type === 'tool_use');
  if (!block) return { error: 'no_tool_use' };
  return { out: block.input, model };
}

export default async (req) => {
  const started = Date.now();
  const deadline = started + 8600;
  const left = () => deadline - Date.now();

  let store;
  try { store = getStore({ name: 'otp-bank', consistency: 'strong' }); }
  catch (e) { return J({ ok: false, error: 'no_store' }); }

  let body = {};
  if (req && req.method === 'POST') { try { body = await req.json(); } catch (e) {} }
  const read = async (k, d) => { try { const v = await store.get(k, { type: 'json' }); return v ?? d; } catch (e) { return d; } };

  const done = await read(KEY, {});
  if (body.action === 'get') {
    const out = {};
    (Array.isArray(body.names) ? body.names : []).slice(0, 60)
      .forEach(n => { const r = done[slug(n)]; if (r && !r.failed) out[slug(n)] = r; });
    return J({ ok: true, records: out });
  }

  const roster = await read('roster-v1', []);
  const saved = await read('saved-v1', []);
  const lamp = await read('lamp-v1', []);
  const enr = await read('enrich-v1', {});
  const seen = new Set(); const universe = [];
  [].concat(Array.isArray(saved)?saved:[], Array.isArray(lamp)?lamp:[], Array.isArray(roster)?roster:[])
    .forEach(p => { if (!p || !p.n) return; const k = slug(p.n);
      if (seen.has(k)) return; seen.add(k);
      universe.push({ n: p.n, gid: p.gid || null, area: p.hood || p.area || null,
        own: (p.m || []).map(m => m.b).filter(Boolean).join(' ').slice(0, 500) }); });

  if (body.action === 'status')
    return J({ ok: true, known: Object.keys(done).length, universe: universe.length,
      pending: universe.filter(p => !done[slug(p.n)]).length,
      hasSearchKey: !!(envKey(['BRAVE_SEARCH_KEY','BRAVE_API_KEY','BRAVE_KEY']) ||
        (envKey(['GOOGLE_CSE_KEY','CSE_KEY']) && envKey(['GOOGLE_CSE_CX','CSE_CX']))) });

  const gkey = googleKey(), mkey = modelKey();
  if (!gkey || !mkey) return J({ ok: false, error: !gkey ? 'no_google_key' : 'no_model_key' });
  if (!universe.length) return J({ ok: true, note: 'no roster yet' });

  /* the places whose reviews are already understood come first: the gap needs
     both halves, and enrich.mjs is the other half */
  const pending = universe.filter(p => !done[slug(p.n)]);
  pending.sort((a, b) => (enr[slug(b.n)] ? 1 : 0) - (enr[slug(a.n)] ? 1 : 0));
  if (!pending.length) {
    const stale = universe.filter(p => { const r = done[slug(p.n)];
      return r && (Date.now() - (r.at||0)) > STALE_DAYS*86400e3; });
    if (!stale.length) return J({ ok: true, complete: true, known: Object.keys(done).length });
    pending.push(...stale);
  }

  const batch = pending.slice(0, PER_RUN);
  const results = await Promise.all(batch.map(async p => {
    try {
      // 1. its own words: Google knows the website, we read it
      let site = null;
      if (p.gid) {
        /* grab() sends no auth header, so this call used to fail every time and
           silently fall through to a second lookup. Places needs the key. */
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 2000);
        try {
          const r = await fetch(`https://places.googleapis.com/v1/places/${p.gid}?languageCode=en-GB`,
            { signal: ac.signal, headers: { 'X-Goog-Api-Key': gkey,
              'X-Goog-FieldMask': 'websiteUri' } });
          if (r.ok) site = (await r.json()).websiteUri || null;
        } catch (e) {} finally { clearTimeout(to); }
      }
      if (!site) {
        const s = await post('https://places.googleapis.com/v1/places:searchText',
          { 'X-Goog-Api-Key': gkey, 'X-Goog-FieldMask': 'places.websiteUri,places.id' },
          { textQuery: [p.n, p.area, 'London'].filter(Boolean).join(', '),
            maxResultCount: 1, languageCode: 'en-GB', regionCode: 'GB' }, 2200);
        site = s && s.places && s.places[0] && s.places[0].websiteUri;
      }
      const own = { url: site || null, text: '' };
      if (site && left() > 4000) {
        const html = await grab(site, 2500);
        if (html) {
          own.text = textOf(html, 4500);
          const subs = subPages(html, site);
          /* many venue sites are JS shells with no readable text on the
             homepage; the about/menu page is often plain HTML */
          if (subs.length && (left() > 4500 || own.text.length < 200)) {
            const extra = await grab(subs[0], 2000);
            if (extra) own.text += '\n\n[' + subs[0] + ']\n' + textOf(extra, 3000);
          }
        }
      }

      // 2. what has been published about it, if a search key exists
      let pressBits = [], noSearch = null;
      if (left() > 4000) {
        const pr = await press(p.n, p.area);
        if (pr.none) noSearch = pr.none;
        for (const h of (pr.hits || [])) {
          if (left() < 4200) break;
          const html = await grab(h.url, 2000);
          pressBits.push({ title: h.title, url: h.url,
            text: html ? textOf(html, 2500) : (h.snippet || '') });
        }
      }

      if (!own.text && !pressBits.length)
        return { n: p.n, error: noSearch === 'no_search_key' && !site ? 'nothing_to_read' : 'no_text' };

      const e = enr[slug(p.n)];
      const reviewLine = e && !e.failed
        ? [e.vibe, e.avoidIf ? 'Recurring complaint: ' + e.avoidIf : null].filter(Boolean).join(' ')
        : null;
      const d = await distil(p, own, pressBits, reviewLine, mkey);
      if (d.error) return { n: p.n, error: d.error };
      const o = d.out;
      return { n: p.n, rec: {
        n: p.n,
        claims: o.claims ? String(o.claims).slice(0, 600) : null,
        story: o.story ? String(o.story).slice(0, 500) : null,
        pressSays: o.pressSays ? String(o.pressSays).slice(0, 600) : null,
        gap: o.gap ? String(o.gap).slice(0, 400) : null,
        signature: (o.signature || []).slice(0, 6).map(x => String(x).slice(0, 60)),
        sources: (o.sources || []).slice(0, 5)
          .filter(s => s && /^https?:\/\//.test(s.url))
          .map(s => ({ title: String(s.title || '').slice(0, 90), url: String(s.url).slice(0, 300) })),
        confidence: ['high','medium','low'].includes(o.confidence) ? o.confidence : 'medium',
        read: { site: !!own.text, press: pressBits.length, searchKey: !noSearch, model: d.model },
        at: Date.now(),
      } };
    } catch (e) { return { n: p.n, error: 'exception' }; }
  }));

  let wrote = 0;
  for (const r of results) {
    if (r.rec) { done[slug(r.n)] = r.rec; wrote++; }
    else if (r.error && !done[slug(r.n)]) done[slug(r.n)] = { n: r.n, failed: r.error, at: Date.now() };
  }
  await store.setJSON(KEY, done);

  return J({ ok: true, wrote, known: Object.keys(done).length,
    pending: universe.filter(p => !done[slug(p.n)]).length,
    took: results.map(r => r.n),
    errors: results.filter(r => r.error).map(r => r.n + ':' + r.error),
    ms: Date.now() - started });
};
