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

// Allowed proxy endpoints — whitelist only, prevents open-proxy abuse
const ALLOWED_TYPES = new Set(['hotspots', 'nearby']);

export default async function handler(req, res) {

  // CORS
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

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
