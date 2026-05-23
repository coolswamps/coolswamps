/**
 * /api/geocode
 *
 * Server-side proxy for Nominatim geocoding requests.
 *
 * Direct browser fetch to Nominatim fails in two ways:
 *  1. Nominatim flags requests without a compliant User-Agent header;
 *     browsers block setting User-Agent on fetch() (forbidden header).
 *  2. CSP connect-src whitelisting nominatim.openstreetmap.org causes
 *     preflight failures in some browser/proxy combinations.
 *
 * This proxy sets a proper User-Agent, caches responses at the edge,
 * and keeps the same-origin security model intact.
 *
 * Query parameters:
 *   lat + lng  → reverse geocode (returns Nominatim /reverse JSON)
 *   q          → forward geocode, US only (returns Nominatim /search JSON)
 */

const BASE = 'https://nominatim.openstreetmap.org';

const HEADERS = {
  'User-Agent': 'CoolSwamps/1.0 (+https://coolswamps.com)',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en',
  'Referer': 'https://coolswamps.com/',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const { lat, lng, q } = req.query;

  let url;

  if (lat !== undefined && lng !== undefined) {
    const latN = parseFloat(lat);
    const lngN = parseFloat(lng);
    if (isNaN(latN) || isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }
    url = `${BASE}/reverse?lat=${latN}&lon=${lngN}&format=json&addressdetails=1`;
  } else if (q && typeof q === 'string' && q.trim().length > 0) {
    url = `${BASE}/search?q=${encodeURIComponent(q.trim())}&format=json&countrycodes=us&limit=1&addressdetails=1`;
  } else {
    res.status(400).json({ error: 'Provide lat+lng for reverse geocoding or q for forward geocoding' });
    return;
  }

  try {
    const upstream = await fetch(url, { headers: HEADERS });
    const data = await upstream.json();

    res
      .status(upstream.status)
      .setHeader('Content-Type', 'application/json')
      .setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
      .json(data);
  } catch {
    res.status(502).json({ error: 'Geocoding service unavailable' });
  }
}
