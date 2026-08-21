// Plans: a night held together. Stops in order, an optional target time to
// work the clock backwards from, and whatever looseness the person left in.
// The chat assembles them; this store just keeps them safe across devices.
//
// Netlify Functions v2 handler — Blobs credentials are only injected into v2
// functions (see saved.mjs for the scar tissue behind this comment).

import { getStore } from '@netlify/blobs';

const KEY = 'plans-v1';
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

const s = (v, n) => v ? String(v).slice(0, n) : null;

function cleanStop(x) {
  if (!x || !x.n) return null;
  const lat = Number(x.lat), lng = Number(x.lng);
  return {
    n: String(x.n).slice(0, 100),
    lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null,
    kind: s(x.kind, 20), role: s(x.role, 30),
    evId: s(x.evId, 80),                     // an event stop remembers its event
    arrive: s(x.arrive, 30), leave: s(x.leave, 30),   // ISO times when the clock has run
  };
}

function cleanPlan(p) {
  const stops = (Array.isArray(p.stops) ? p.stops : []).map(cleanStop).filter(Boolean).slice(0, 8);
  if (!stops.length) return null;
  const title = String(p.title || 'A plan').slice(0, 80);
  return {
    id: s(p.id, 100) || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) + '-' + Date.now().toString(36),
    title,
    when: s(p.when, 30),                     // the day it is for (ISO date), if known
    targetEnd: s(p.targetEnd, 30),           // "make the dance by 3am" — ISO, drives the backward clock
    notes: s(p.notes, 300),
    updatedAt: Date.now(),
    stops };
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
  try { store = getStore({ name: 'otp-bank', consistency: 'strong' }); }
  catch (e) { return J({ error: 'no_store', detail: String(e && e.message || e) }); }

  try {
    // reading is open — it is your own site; writing needs the passphrase
    if (action === 'list') {
      const plans = await readAll(store);
      return J({ plans: plans.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 40) });
    }

    const auth = passOk(body.pass);
    if (!auth.ok) return J({ error: auth.why });

    if (action === 'save') {
      const plan = cleanPlan(body.plan || {});
      if (!plan) return J({ error: 'bad_plan' });
      const all = await readAll(store);
      const at = all.findIndex(x => x.id === plan.id);
      if (at >= 0) all[at] = plan; else all.push(plan);
      await store.setJSON(KEY, all.slice(-40));
      return J({ ok: true, plan, count: all.length });
    }

    if (action === 'delete') {
      const id = String(body.id || '');
      const all = await readAll(store);
      const left = all.filter(x => x.id !== id);
      await store.setJSON(KEY, left);
      return J({ ok: true, count: left.length });
    }

    return J({ error: 'unknown_action' });
  } catch (e) {
    return J({ error: 'exception', detail: String(e && e.message || e) });
  }
};
