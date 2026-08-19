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
      return J({ events, count: events.length, srcs, refreshedAt: newest || null });
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

    if (action === 'clear') {
      await store.setJSON(KEY, []);
      return J({ ok: true, count: 0 });
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
