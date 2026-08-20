// The travel-time midpoint. "She's in Peckham, I'm in Northolt, somewhere in
// the middle" used to mean the geometric midpoint, which lands in a park
// nobody can reach. This asks TfL for the actual journey between the two and
// returns the interchange closest to halfway BY TIME — the place where both
// people have travelled about the same number of minutes.
//
// One TfL call. No key needed at this volume; TfL's journey API is free.
// Plain HTTP function — never give this a schedule (see the 403 lesson).

const TFL = 'https://api.tfl.gov.uk/Journey/JourneyResults/';

const inLondon = (lat, lng) => lat > 51.2 && lat < 51.8 && lng > -0.6 && lng < 0.4;

function minsBetween(a, b) {           // ISO local timestamps from TfL
  return Math.round((new Date(b) - new Date(a)) / 60000);
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const a = body.a || {}, b = body.b || {};
  const alat = Number(a.lat), alng = Number(a.lng), blat = Number(b.lat), blng = Number(b.lng);
  if (![alat, alng, blat, blng].every(isFinite) || !inLondon(alat, alng) || !inLondon(blat, blng))
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'bad_points' }) };

  // journey planned for the time they actually mean, not for right now
  const qs = new URLSearchParams({ timeIs: 'Departing' });
  if (body.when) {
    const w = new Date(body.when);
    if (!isNaN(w) && w > new Date()) {
      // TfL wants local London time, and this function may run anywhere
      const uk = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(w).reduce((o, p) => (o[p.type] = p.value, o), {});
      qs.set('date', uk.year + uk.month + uk.day);
      qs.set('time', uk.hour + uk.minute);
    }
  }

  try {
    const url = TFL + alat + '%2C' + alng + '/to/' + blat + '%2C' + blng + '?' + qs;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    // TfL returns 300 when a point is ambiguous; anything not-ok is a miss
    if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ error: 'tfl_' + r.status }) };
    const d = await r.json();
    const j = (d.journeys || [])[0];
    if (!j || !j.legs || !j.legs.length)
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_journey' }) };

    const total = j.duration;
    const t0 = j.startDateTime;

    /* every interchange along the route is a candidate meeting point.
       Real timestamps (not summed leg durations) so waits count. */
    const cands = [];
    for (let i = 0; i < j.legs.length - 1; i++) {           // skip the final arrival: that is just B
      const leg = j.legs[i];
      const ap = leg.arrivalPoint || {};
      if (ap.lat == null || ap.lon == null) continue;
      const cum = minsBetween(t0, leg.arrivalTime);
      if (!isFinite(cum) || cum <= 0 || cum >= total) continue;
      cands.push({
        name: (ap.commonName || 'the interchange')
          .replace(/ Rail Station| Underground Station| Station| \(London\)/g, '').trim(),
        lat: ap.lat, lon: ap.lon,
        tA: cum, tB: total - cum,
        off: Math.abs(2 * cum - total),                     // unfairness in minutes
      });
    }
    if (!cands.length)
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'no_interchange', total }) };

    cands.sort((x, y) => x.off - y.off);
    const best = cands[0];
    return { statusCode: 200, headers, body: JSON.stringify({
      name: best.name, lat: best.lat, lng: best.lon,
      tA: best.tA, tB: best.tB, total,
      via: (j.legs || []).map(l => l.mode && l.mode.id).filter(m => m && m !== 'walking').join(' + ') || 'walking',
    }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'exception', detail: String(e).slice(0, 200) }) };
  }
};
