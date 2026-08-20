// The USP: deep, contextual understanding of every place in the bank.
//
// A list is a phone book. This is the layer that makes the bank *know* things —
// what a place actually feels like, who it suits, what it's for, in Tope's
// register rather than marketing copy. It reads Google's own review corpus and
// editorial summary, then has the model distil it. Every claim carries a source
// so it can never quietly become confident nonsense.
//
// Runs as a Netlify scheduled function every 10 minutes and chews through the
// bank a few places at a time until everything is done, then goes quiet —
// waking only for places added since (a new save, a Lamp import). Idempotent:
// it picks the oldest-unenriched first, so it always converges and never
// re-spends on work already banked.
//
// v2 handler (Blobs) + config.schedule.

import { getStore } from '@netlify/blobs';

/* NOT scheduled. Netlify blocks HTTP access to scheduled functions with a
   403, and the app must be able to READ this over HTTP. cron.mjs is the
   scheduled function and it pokes this one. Do not add a schedule here. */

const KEY = 'enrich-v1';          // { slug: record }
const QKEY = 'enrich-queue-v1';   // names the app has asked to jump the queue
/* 6 per run every 5 minutes = ~72/hour, so a bank of ~850 (501 + Angus's
   London places) is fully understood in about twelve hours rather than
   thirty-five. Six parallel read+distil pairs still fit the 10s budget. */
const PER_RUN = 6;
const STALE_DAYS = 120;           // a re-read this old is worth refreshing

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

async function fetchJson(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal });
        return r.ok ? await r.json() : null; }
  catch (e) { return null; }
  finally { clearTimeout(t); }
}

/* Google is the review corpus: what hundreds of people who actually went
   said, plus Google's own editorial summary where it exists. */
async function readPlace(p, gkey) {
  if (!gkey) return null;
  let id = p.gid || null;
  if (!id) {
    const s = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'X-Goog-Api-Key': gkey,
                 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({ textQuery: [p.n, p.addr || p.area, 'London'].filter(Boolean).join(', '),
        maxResultCount: 1, languageCode: 'en-GB', regionCode: 'GB' }),
    }, 2500);
    id = s && s.places && s.places[0] && s.places[0].id;
  }
  if (!id) return null;
  const mask = ['id','displayName','shortFormattedAddress','primaryTypeDisplayName','types',
    'rating','userRatingCount','priceLevel','editorialSummary','generativeSummary',
    'reviews','websiteUri','servesBeer','servesCocktails','servesVegetarianFood',
    'outdoorSeating','liveMusic','goodForGroups','goodForWatchingSports','reservable',
    'takeout','delivery','dineIn','allowsDogs','restroom','paymentOptions'].join(',');
  const d = await fetchJson(`https://places.googleapis.com/v1/places/${id}?languageCode=en-GB`, {
    headers: { 'X-Goog-Api-Key': gkey, 'X-Goog-FieldMask': mask },
  }, 3500);
  return d ? { id, ...d } : null;
}

const SCHEMA = {
  name: 'understanding',
  description: 'What this place is actually like, distilled from the evidence.',
  input_schema: {
    type: 'object',
    properties: {
      vibe: { type: 'string', description: 'Two or three sentences on what it FEELS like to be there — light, noise, crowd, pace. Concrete and specific. No marketing words ("hidden gem", "must-visit", "vibrant").' },
      bestFor: { type: 'array', items: { type: 'string' },
        description: 'Occasions it genuinely suits, e.g. "first date", "solo lunch with a book", "a big loud group", "late drinks", "taking your parents". 2-5 items.' },
      avoidIf: { type: 'string', description: 'The honest caveat — who would not enjoy this and why. Null if there is no real caveat.' },
      order: { type: 'array', items: { type: 'string' }, description: 'What reviewers repeatedly say to order. Only dishes actually named in the evidence. Empty if none.' },
      tags: { type: 'array', items: { type: 'string' },
        description: 'Short lowercase vibe tags from this fixed set where they fit: cosy, lively, loud, quiet, romantic, natural-wine, listening-bar, outdoor, garden, terrace, late, cheap, special-occasion, walk-in, bookable, groups, solo-friendly, dog-friendly, live-music, dancing, view, hidden, no-frills, buzzy, date-spot, work-friendly.' },
      description: { type: 'string', description: 'One paragraph a friend would actually say out loud, in plain British English. This is used where the place has no description of its own.' },
      confidence: { type: 'string', enum: ['high','medium','low'],
        description: 'high = plenty of consistent evidence; low = thin or contradictory. Be honest.' },
    },
    required: ['vibe','bestFor','tags','description','confidence'],
  },
};

const SYSTEM = `You read the evidence about a venue and distil what it is ACTUALLY like.

You are writing for one person's private map of places they trust. Rules:
- Ground every statement in the evidence given. If the evidence does not support a claim, leave it out. Never invent dishes, prices, history or awards.
- Write like a straight-talking friend, British English, no marketing register. Banned: hidden gem, must-visit, vibrant, nestled, culinary journey, elevated, iconic, stunning.
- Reviews contradict each other; say what the WEIGHT of them says, and use avoidIf for the real complaint that keeps recurring.
- If the evidence is thin, say so via confidence:'low' and keep the writing short rather than padding it.
- Where the owner's words and the reviewers' words disagree, trust the reviewers.`;

async function distil(place, g, mkey) {
  let model = process.env.OTP_MODEL || null;
  if (!model) {
    const r = await fetchJson('https://api.anthropic.com/v1/models?limit=100',
      { headers: { 'x-api-key': mkey, 'anthropic-version': '2023-06-01' } }, 2500);
    const ids = ((r && r.data) || []).map(m => m.id);
    model = ids.find(i => /haiku/i.test(i)) || ids.find(i => /sonnet/i.test(i)) || ids[0];
  }
  if (!model) model = 'claude-haiku-4-5';

  const revs = (g.reviews || []).slice(0, 8).map(r =>
    `- (${r.rating}★) ${((r.text||{}).text || (r.originalText||{}).text || '').slice(0, 700)}`).join('\n');
  const feats = Object.entries({
    outdoorSeating: g.outdoorSeating, liveMusic: g.liveMusic, goodForGroups: g.goodForGroups,
    reservable: g.reservable, dineIn: g.dineIn, takeout: g.takeout, allowsDogs: g.allowsDogs,
    servesCocktails: g.servesCocktails, servesBeer: g.servesBeer,
    servesVegetarianFood: g.servesVegetarianFood,
  }).filter(([,v]) => v === true).map(([k]) => k).join(', ');

  // the bank's own words matter most: they are why the place is on the map
  const mine = (place.m || []).map(m => m.b).filter(Boolean).join(' ');

  const evidence = [
    `VENUE: ${place.n}`,
    g.shortFormattedAddress ? `ADDRESS: ${g.shortFormattedAddress}` : null,
    place.hood || place.area ? `AREA: ${place.hood || place.area}` : null,
    g.primaryTypeDisplayName ? `GOOGLE CATEGORY: ${(g.primaryTypeDisplayName||{}).text||''}` : null,
    g.rating ? `RATING: ${g.rating} from ${g.userRatingCount} reviews` : null,
    g.priceLevel ? `PRICE LEVEL: ${g.priceLevel}` : null,
    feats ? `GOOGLE ATTRIBUTES: ${feats}` : null,
    (g.editorialSummary||{}).text ? `GOOGLE EDITORIAL: ${(g.editorialSummary||{}).text}` : null,
    (g.generativeSummary||{}).overview ? `GOOGLE SUMMARY: ${(g.generativeSummary||{}).overview.text||''}` : null,
    mine ? `WHY IT IS ON THIS MAP (the writer who recommended it): ${mine.slice(0,900)}` : null,
    place.note ? `THE OWNER OF THE MAP NOTED: ${place.note}` : null,
    revs ? `RECENT REVIEWS:\n${revs}` : null,
  ].filter(Boolean).join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': mkey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1200, system: SYSTEM,
      tools: [SCHEMA], tool_choice: { type: 'tool', name: 'understanding' },
      messages: [{ role: 'user', content: evidence }] }),
  });
  if (!r.ok) return { error: 'model_' + r.status };
  const d = await r.json();
  const block = (d.content || []).find(c => c.type === 'tool_use');
  if (!block) return { error: 'no_tool_use' };
  return { out: block.input, model, reviewsSeen: (g.reviews||[]).length };
}

export default async (req) => {
  const started = Date.now();
  const deadline = started + 8500;
  const left = () => deadline - Date.now();

  let store;
  try { store = getStore({ name: 'otp-bank', consistency: 'strong' }); }
  catch (e) { return J({ ok: false, error: 'no_store', detail: String(e && e.message || e) }); }

  // manual invocation can pass {names:[...]} to enrich specific places first
  let body = {};
  if (req && req.method === 'POST') { try { body = await req.json(); } catch (e) {} }

  const gkey = googleKey(), mkey = modelKey();
  if (!gkey || !mkey) return J({ ok: false, error: !gkey ? 'no_google_key' : 'no_model_key' });

  const read = async (k, d) => { try { const v = await store.get(k, { type: 'json' }); return v ?? d; } catch (e) { return d; } };
  const done = await read(KEY, {});
  const saved = await read('saved-v1', []);
  const queue = await read(QKEY, []);

  /* The universe to understand: the baked bank ships inside index.html, so the
     function cannot see it. The app posts the roster once (action:'roster'),
     and every save adds itself. Everything converges from there. */
  const roster = await read('roster-v1', []);
  const universe = [];
  const seen = new Set();
  const push = p => {
    if (!p || !p.n) return;
    const k = slug(p.n);
    if (seen.has(k)) return;
    seen.add(k);
    universe.push(p);
  };
  (Array.isArray(body.places) ? body.places : []).forEach(push);
  (Array.isArray(saved) ? saved : []).forEach(push);
  (Array.isArray(roster) ? roster : []).forEach(push);

  if (body.action === 'roster') {
    const list = (Array.isArray(body.places) ? body.places : [])
      .filter(p => p && p.n).map(p => ({
        n: String(p.n).slice(0,120), gid: p.gid || null,
        addr: p.addr || null, area: p.hood || p.area || null,
        m: (p.m || []).slice(0,2).map(m => ({ b: String(m.b||'').slice(0,600) })),
      })).slice(0, 1200);
    await store.setJSON('roster-v1', list);
    return J({ ok: true, roster: list.length });
  }
  if (body.action === 'status') {
    return J({ ok: true, known: Object.keys(done).length, universe: universe.length,
      queued: queue.length, pending: universe.filter(p => !done[slug(p.n)]).length });
  }
  if (body.action === 'get') {
    const out = {};
    (Array.isArray(body.names) ? body.names : []).slice(0, 60)
      .forEach(n => { const r = done[slug(n)]; if (r) out[slug(n)] = r; });
    return J({ ok: true, records: out });
  }

  if (!universe.length) return J({ ok: true, note: 'no roster yet — app must post action:roster once', done: 0 });

  /* pick this run's work: anything the app asked for first, then never-read,
     then the stalest. Always forward progress, never repeats. */
  const byName = new Map(universe.map(p => [slug(p.n), p]));
  const wanted = [];
  for (const n of queue) { const p = byName.get(slug(n)); if (p && !done[slug(n)]) wanted.push(p); }
  for (const p of universe) if (!done[slug(p.n)] && !wanted.includes(p)) wanted.push(p);
  if (!wanted.length) {
    const stale = universe.filter(p => {
      const r = done[slug(p.n)];
      return r && (Date.now() - (r.at||0)) > STALE_DAYS*86400e3;
    }).sort((a,b) => (done[slug(a.n)].at||0) - (done[slug(b.n)].at||0));
    wanted.push(...stale);
  }
  if (!wanted.length)
    return J({ ok: true, complete: true, known: Object.keys(done).length,
      note: 'the whole bank is understood; waking only for new places' });

  const batch = wanted.slice(0, PER_RUN);
  const results = await Promise.all(batch.map(async p => {
    if (left() < 3000) return { n: p.n, skipped: 'out_of_time' };
    try {
      const g = await readPlace(p, gkey);
      if (!g) return { n: p.n, error: 'not_found_on_google' };
      if (left() < 2500) return { n: p.n, skipped: 'out_of_time' };
      const d = await distil(p, g, mkey);
      if (d.error) return { n: p.n, error: d.error };
      return { n: p.n, rec: {
        n: p.n, gid: g.id,
        vibe: String(d.out.vibe||'').slice(0,700),
        bestFor: (d.out.bestFor||[]).slice(0,5).map(x=>String(x).slice(0,60)),
        avoidIf: d.out.avoidIf ? String(d.out.avoidIf).slice(0,300) : null,
        order: (d.out.order||[]).slice(0,6).map(x=>String(x).slice(0,60)),
        tags: (d.out.tags||[]).slice(0,10).map(x=>String(x).toLowerCase().slice(0,24)),
        description: String(d.out.description||'').slice(0,900),
        confidence: ['high','medium','low'].includes(d.out.confidence) ? d.out.confidence : 'medium',
        // provenance: what this understanding was actually built from
        src: { reviews: d.reviewsSeen, rating: g.rating||null, count: g.userRatingCount||null,
               editorial: !!(g.editorialSummary||{}).text, model: d.model, own: !!(p.m||[]).length },
        at: Date.now(),
      } };
    } catch (e) { return { n: p.n, error: 'exception' }; }
  }));

  let wrote = 0;
  for (const r of results) if (r.rec) { done[slug(r.n)] = r.rec; wrote++; }
  if (wrote) await store.setJSON(KEY, done);
  // failures are recorded as attempted so a permanently-unfindable place cannot
  // block the queue forever — it gets one more go on the stale sweep
  for (const r of results) if (r.error && !done[slug(r.n)]) {
    done[slug(r.n)] = { n: r.n, failed: r.error, at: Date.now(), confidence: 'low' };
  }
  if (results.some(r => r.error)) await store.setJSON(KEY, done);
  if (queue.length) await store.setJSON(QKEY, queue.filter(n => !done[slug(n)]));

  const pending = universe.filter(p => !done[slug(p.n)]).length;
  return J({ ok: true, wrote, pending, known: Object.keys(done).length,
    took: results.map(r => r.n),
    errors: results.filter(r => r.error).map(r => r.n + ':' + r.error),
    ms: Date.now() - started });
};
