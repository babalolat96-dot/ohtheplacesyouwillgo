// The one scheduled function. Everything else is a normal HTTP function.
//
// Why it exists: Netlify BLOCKS HTTP access to a scheduled function — a browser
// request gets a flat 403. The Lamp importer, the understanding engine and the
// editorial reader all have to be readable by the app (it POSTs {action:'list'}
// or {action:'get'} to them), so none of them can carry a schedule. This does
// the waking instead: every five minutes it pokes each worker, server to
// server, which makes them do one batch of work.
//
// If a worker is ever unreachable, the response says which and why, so the
// Netlify function log for `cron` is the single place to look when nothing
// seems to be progressing.

export const config = { schedule: '*/5 * * * *' };

const WORKERS = ['lamp', 'enrich', 'editorial'];

export default async () => {
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  if (!base)
    return new Response(JSON.stringify({ ok: false, error: 'no_site_url' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });

  const out = {};
  await Promise.all(WORKERS.map(async name => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 9500);
    try {
      const r = await fetch(base + '/api/' + name, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        // no action = "do a batch of work"
        body: JSON.stringify({ via: 'cron' }),
      });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 300); }
      out[name] = { status: r.status, body };
    } catch (e) {
      out[name] = { error: String(e && e.name === 'AbortError' ? 'timeout' : (e && e.message || e)) };
    } finally { clearTimeout(t); }
  }));

  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), ran: out }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};
