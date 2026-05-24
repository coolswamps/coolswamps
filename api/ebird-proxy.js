/**
 * /api/ebird-proxy
 *
 * Server-side proxy for the eBird API.
 * Keeps the EBIRD_API_KEY secret — never exposed to the browser.
 *
 * Required Vercel env var:
 *   EBIRD_API_KEY  — free key from https://ebird.org/api/keygen
 *
 * Usage from client:
 *   GET /api/ebird-proxy?type=hotspots&lat=36.5&lng=-76.4&dist=50
 *   GET /api/ebird-proxy?type=nearby&lat=36.5&lng=-76.4&dist=50
 */

const EBIRD_API_KEY   = process.env.EBIRD_API_KEY;
const EBIRD_BASE      = 'https://api.ebird.org/v2';
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN ?? 'https://coolswamps.com';
const RATE_LIMIT_MAX  = 60; // requests per IP per hour — eBird free tier is generous but finite

// Allowed proxy endpoints — whitelist only, prevents open-proxy abuse
const ALLOWED_TYPES = new Set(['hotspots', 'nearby']);

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

  // CORS
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting — use Vercel's trusted IP headers (not client-spoofable)
  const clientIp =
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
  }

  if (!EBIRD_API_KEY) {
    console.error('EBIRD_API_KEY is not set');
    return res.status(503).json({ error: 'eBird integration not configured' });
  }

  const { type, lat, lng, dist = '50' } = req.query;

  // Validate type
  if (!ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: 'Invalid type parameter' });
  }

  // Validate coordinates
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  const distN = Math.min(parseInt(dist, 10), 200); // cap at 200km

  if (isNaN(latN) || latN < -90  || latN > 90)  return res.status(400).json({ error: 'Invalid latitude' });
  if (isNaN(lngN) || lngN < -180 || lngN > 180) return res.status(400).json({ error: 'Invalid longitude' });

  let eBirdUrl;

  if (type === 'hotspots') {
    // Nearby eBird hotspots
    eBirdUrl = `${EBIRD_BASE}/ref/hotspot/geo?lat=${latN}&lng=${lngN}&dist=${distN}&fmt=json`;
  } else if (type === 'nearby') {
    // Recent nearby bird observations
    eBirdUrl = `${EBIRD_BASE}/data/obs/geo/recent?lat=${latN}&lng=${lngN}&dist=${distN}&maxResults=100&fmt=json`;
  }

  try {
    const upstream = await fetch(eBirdUrl, {
      headers: {
        'X-eBirdApiToken': EBIRD_API_KEY,
        'User-Agent': 'CoolSwamps/1.0 (https://coolswamps.com)',
      },
    });

    if (!upstream.ok) {
      console.error(`eBird API error: ${upstream.status}`);
      return res.status(502).json({ error: 'eBird API error' });
    }

    const data = await upstream.json();

    // Cache for 1 hour — eBird hotspots don't change often
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    return res.status(200).json(data);

  } catch (err) {
    console.error('eBird proxy error:', err);
    return res.status(500).json({ error: 'Failed to fetch eBird data' });
  }
}
