// What's on: the events feed. A weekly scout (a scheduled Claude session)
// reads the sources — orixa.fm for the afro house / gqom / 3-step / amapiano
// side, plus the editorial list — and writes the curated set here. The app
// only ever reads. Same shape of trust as the bank: nothing appears unless
// something real (a ticket page, a venue address) stands behind it.
//
// Netlify Functions *v2* handler — Blobs credentials are only injected into
// v2 functions (see saved.mjs for the scar tissue behind this comment).

import { getStore } from '@netlify/blobs';

const KEY = 'events-v1';
const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function passOk(given) {
  const want = (process.env.OTP_PASS || '').trim();
  if (!want) return { ok: false, why: 'no_pass_set' };
  if (String(given || '').trim() !== want) return { ok: false, why: 'bad_pass' };
  return { ok: true };
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
const s = (v, n) => v ? String(v).slice(0, n) : null;

function clean(e) {
  const title = String(e.title || '').trim().slice(0, 160);
  const start = Date.parse(e.start || '');
  if (!title || !isFinite(start)) return null;
  // a link someone can actually act on — tickets or at least the listing
  const url = /^https:\/\//.test(String(e.url || '')) ? String(e.url).slice(0, 300) : null;
  let lat = Number(e.lat), lng = Number(e.lng);
  if (!(isFinite(lat) && isFinite(lng) && lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4)) {
    lat = null; lng = null;
  }
  return {
    id: slug(title) + '-' + new Date(start).toISOString().slice(0, 10),
    title,
    artists: Array.isArray(e.artists) ? e.artists.slice(0, 12).map(a => String(a).slice(0, 60)) : [],
    venue: s(e.venue, 100), addr: s(e.addr || e.address, 200), area: s(e.area, 60),
    lat, lng,
    start: new Date(start).toISOString(),
    end: isFinite(Date.parse(e.end || '')) ? new Date(Date.parse(e.end)).toISOString() : null,
    url,
    src: s(e.src, 30) || 'scout',
    genres: Array.isArray(e.genres) ? e.genres.slice(0, 6).map(g => String(g).toLowerCase().slice(0, 30)) : [],
    why: s(e.why, 240),          // the scout's one honest line on why it made the cut
    fetchedAt: Date.now(),
  };
}

async function readAll(store) {
  try {
    const v = await store.get(KEY, { type: 'json' });
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

export default async (req) => {
  if (req.method !== 'POST') return J({ error: 'POST only' }, 405);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const action = String(body.action || 'list');

  let store;
  try {
    store = getStore({ name: 'otp-bank', consistency: 'strong' });
  } catch (e) {
    return J({ error: 'no_store', detail: String(e && e.message || e) });
  }

  try {
    // reading is open: it is your own feed on your own site
    if (action === 'list') {
      const all = await readAll(store);
      const floor = Date.now() - 6 * 3600 * 1000;   // tonight's event is live until it's over
      const events = all.filter(x => Date.parse(x.start) >= floor)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .slice(0, 200);
      const srcs = [...new Set(all.map(x => x.src))];
      const newest = all.reduce((m, x) => Math.max(m, x.fetchedAt || 0), 0);
      /* venues the events have taught us: name -> real place, so the app can
         pin an event properly and the AI knows the venue as its own thing */
      let venues = {};
      try { const v = await store.get('evvenues-v1', { type: 'json' });
        if (v && typeof v === 'object') venues = v; } catch (e) {}
      /* the personal layer: which events are loved, which are already GOING
         (tickets, guest list) — the difference between browsing and a plan */
      let marks = {};
      try { const v = await store.get('evmarks-v1', { type: 'json' });
        if (v && typeof v === 'object') marks = v; } catch (e) {}
      return J({ events, count: events.length, srcs, refreshedAt: newest || null, venues, marks });
    }

    /* the flyer: an event's own page carries a share-image and a blurb in its
       meta tags. Fetch them ONCE per event and cache. SSRF-safe by design:
       only URLs already stored in the feed are ever fetched — the id picks
       the event, never a caller-supplied address. Open read, like the feed. */
    if (action === 'flyer') {
      const id = String(body.id || '').slice(0, 80);
      const all = await readAll(store);
      const ev = all.find(x => x.id === id);
      if (!ev || !ev.url) return J({ error: 'unknown_event' });
      let cache = {};
      try { const v = await store.get('evflyers-v1', { type: 'json' });
        if (v && typeof v === 'object') cache = v; } catch (e) {}
      if (cache[id] && cache[id].at > Date.now() - 7 * 86400e3)
        return J({ ok: true, image: cache[id].image, desc: cache[id].desc });
      try {
        const r = await fetch(ev.url, { redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; OTP-scout/1.0)' },
          signal: AbortSignal.timeout(7000) });
        const html = r.ok ? (await r.text()).slice(0, 300000) : '';
        const og = (html.match(/property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)/i)
          || html.match(/content=["']([^"']+)["'][^>]*property=["']og:image/i) || [])[1] || null;
        const desc = (html.match(/property=["']og:description["'][^>]*content=["']([^"']{1,400})/i) || [])[1] || null;
        const rec = { image: og && /^https:\/\//.test(og) ? og.slice(0, 500) : null,
          desc: desc || null, at: Date.now() };
        cache[id] = rec;
        const ks = Object.keys(cache);
        if (ks.length > 120)
          ks.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
            .slice(0, ks.length - 120).forEach(k => delete cache[k]);
        await store.setJSON('evflyers-v1', cache);
        return J({ ok: true, image: rec.image, desc: rec.desc });
      } catch (e) { return J({ ok: false, error: 'unreachable' }); }
    }


    const auth = passOk(body.pass);
    if (!auth.ok) return J({ error: auth.why });

    if (action === 'check') return J({ ok: true });

    // the weekly scout replaces the whole horizon in one write: idempotent,
    // and a source that disappears takes its stale events with it
    if (action === 'set') {
      const events = (Array.isArray(body.events) ? body.events : [])
        .map(clean).filter(Boolean).slice(0, 300);
      await store.setJSON(KEY, events);
      return J({ ok: true, count: events.length });
    }

    // one-off additions (a link you paste mid-week) merge by id
    if (action === 'add') {
      const fresh = (Array.isArray(body.events) ? body.events : [body.event])
        .map(clean).filter(Boolean);
      if (!fresh.length) return J({ error: 'bad_events' });
      const all = await readAll(store);
      fresh.forEach(rec => {
        const at = all.findIndex(x => x.id === rec.id);
        if (at >= 0) all[at] = { ...all[at], ...rec };
        else all.push(rec);
      });
      await store.setJSON(KEY, all.slice(-300));
      return J({ ok: true, added: fresh.length, count: all.length });
    }

    /* mark an event: fav (love it) and/or going ('tickets' | 'guestlist').
       Clearing both clears the mark. */
    if (action === 'mark') {
      const id = String(body.id || '').slice(0, 80);
      if (!id) return J({ error: 'bad_id' });
      let marks = {};
      try { const v = await store.get('evmarks-v1', { type: 'json' });
        if (v && typeof v === 'object') marks = v; } catch (e) {}
      const cur = marks[id] || {};
      if ('fav' in body) cur.fav = !!body.fav;
      if ('going' in body)
        cur.going = body.going === 'guestlist' ? 'guestlist' : (body.going ? 'tickets' : null);
      if (!cur.fav && !cur.going) delete marks[id];
      else marks[id] = { fav: !!cur.fav, going: cur.going || null, at: Date.now() };
      const ks = Object.keys(marks);
      if (ks.length > 150)
        ks.sort((a, b) => (marks[a].at || 0) - (marks[b].at || 0))
          .slice(0, ks.length - 150).forEach(k => delete marks[k]);
      await store.setJSON('evmarks-v1', marks);
      return J({ ok: true, mark: marks[id] || null });
    }

    if (action === 'clear') {
      await store.setJSON(KEY, []);
      return J({ ok: true, count: 0 });
    }

    /* events teach the venue bank: the app resolves an event's venue through
       /api/find (type-filtered, so a solicitors never answers for a bar) and
       stores the result here. From then on the venue is a known place — the
       map pins it exactly, and the roster hands it to the understanding
       engine so the AI learns what kind of place it is. */
    if (action === 'savevenues') {
      const fresh = (Array.isArray(body.venues) ? body.venues : []).slice(0, 12);
      let known = {};
      try { const v = await store.get('evvenues-v1', { type: 'json' });
        if (v && typeof v === 'object') known = v; } catch (e) {}
      let added = 0;
      for (const v of fresh) {
        const key2 = String(v.venue || '').trim().toLowerCase().slice(0, 80);
        if (!key2 || known[key2]) continue;
        const lat = Number(v.lat), lng = Number(v.lng);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        known[key2] = {
          name: String(v.name || v.venue).slice(0, 80),
          lat, lng,
          gid: String(v.gid || '').slice(0, 100) || null,
          addr: String(v.addr || '').slice(0, 120) || null,
          kind: String(v.kind || '').slice(0, 20) || null,
          learnedAt: Date.now(),
        };
        added++;
      }
      const keys = Object.keys(known);
      if (keys.length > 200)
        keys.sort((a, b) => (known[a].learnedAt || 0) - (known[b].learnedAt || 0))
          .slice(0, keys.length - 200).forEach(k => delete known[k]);
      await store.setJSON('evvenues-v1', known);
      return J({ ok: true, added, total: Object.keys(known).length });
    }

    /* follow a DJ: their pages live at guessable addresses. Probe them, hand
       back what was actually found (title + whether it mentions the name),
       and let the HUMAN pick the right one — verification stays with Tope,
       the fetching stays here. Pass-gated like every write path. */
    if (action === 'djprobe') {
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return J({ error: 'bad_name' });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const slugDash = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const cands = [];
      if (/^https:\/\/\S{4,300}$/.test(body.url || '')) cands.push(String(body.url));
      cands.push('https://ra.co/dj/' + slug,
                 'https://soundcloud.com/' + slugDash,
                 'https://linktr.ee/' + slug);
      const out = [];
      for (const url of [...new Set(cands)].slice(0, 4)) {
        try {
          const r = await fetch(url, { redirect: 'follow',
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; OTP-scout/1.0)' },
            signal: AbortSignal.timeout(6000) });
          if (!r.ok) { out.push({ url, ok: false, status: r.status }); continue; }
          const html = (await r.text()).slice(0, 200000);
          const title = ((html.match(/<title[^>]*>([^<]{1,140})/i) || [])[1] || '').trim() || null;
          const flat = html.replace(/\s+/g, ' ').toLowerCase();
          const mentions = flat.includes(name.toLowerCase())
            || flat.replace(/[^a-z0-9]/g, '').includes(slug);
          out.push({ url, ok: true, title, mentions });
        } catch (e) { out.push({ url, ok: false, error: 'unreachable' }); }
      }
      return J({ ok: true, name, candidates: out });
    }

    /* ...and once the human says "that's them", the page joins the scout's
       weekly read as a DJ source. Their gigs then land in the feed. */
    if (action === 'follow') {
      const name = String(body.name || '').trim().slice(0, 60);
      const url = String(body.url || '');
      if (!name || !/^https:\/\/\S{4,300}$/.test(url)) return J({ error: 'bad_follow' });
      let srcs = [];
      try { const v = await store.get('evsources-v1', { type: 'json' }); srcs = Array.isArray(v) ? v : []; } catch (e) {}
      if (!srcs.some(s => s.url === url))
        srcs.push({ url, label: 'DJ: ' + name, kind: 'dj', dj: name, addedAt: Date.now() });
      await store.setJSON('evsources-v1', srcs.slice(-30));
      return J({ ok: true, sources: srcs.length });
    }

    /* the scout's learned sources: every promoter or listing page the app is
       taught gets read weekly from then on — orixa is the floor, not the
       ceiling. The app adds these when an Instagram event post is imported. */
    if (action === 'addsource') {
      const url = String(body.url || '');
      if (!/^https:\/\/[^\s]{4,300}$/.test(url)) return J({ error: 'bad_url' });
      const label = String(body.label || '').slice(0, 30) || null;
      let srcs = [];
      try { const v = await store.get('evsources-v1', { type: 'json' }); srcs = Array.isArray(v) ? v : []; } catch (e) {}
      if (!srcs.some(s => s.url === url)) srcs.push({ url, label, addedAt: Date.now() });
      await store.setJSON('evsources-v1', srcs.slice(-30));
      return J({ ok: true, sources: srcs.length });
    }
    if (action === 'delsource') {
      let srcs = [];
      try { const v = await store.get('evsources-v1', { type: 'json' }); srcs = Array.isArray(v) ? v : []; } catch (e) {}
      const left = srcs.filter(s => s.url !== String(body.url || ''));
      await store.setJSON('evsources-v1', left);
      return J({ ok: true, sources: left.length });
    }

    return J({ error: 'unknown_action' });
  } catch (e) {
    return J({ error: 'exception', detail: String(e && e.message || e) });
  }
};
