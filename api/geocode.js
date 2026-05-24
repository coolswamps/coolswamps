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

const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN ?? 'https://coolswamps.com';
const RATE_LIMIT_MAX  = parseInt(process.env.RATE_LIMIT_MAX ?? '30', 10); // per IP per hour
const MAX_QUERY_LEN   = 300;

const BASE = 'https://nominatim.openstreetmap.org';

const HEADERS = {
  'User-Agent': 'CoolSwamps/1.0 (+https://coolswamps.com)',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en',
  'Referer': 'https://coolswamps.com/',
};

// In-memory rate limiter (resets on cold start — same policy as other handlers)
/** @type {Map<string, {count: number, resetAt: number}>} */
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

export default async function handler(req, res) {
  // CORS — GET-only endpoint; set origin header so browsers enforce same-origin
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') { res.status(405).end(); return; }

  // Server-side origin check — prevents other sites using this as a free proxy
  const requestOrigin = req.headers['origin'];
  if (requestOrigin && requestOrigin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Rate limiting — use Vercel's trusted IP headers (not client-spoofable)
  const clientIp =
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
  }

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
    // Clamp query length before forwarding to Nominatim (Finding #8)
    const safeQ = q.trim().slice(0, MAX_QUERY_LEN);
    url = `${BASE}/search?q=${encodeURIComponent(safeQ)}&format=json&countrycodes=us&limit=1&addressdetails=1`;
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
