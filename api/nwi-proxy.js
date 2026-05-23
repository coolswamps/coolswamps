/**
 * /api/nwi-proxy
 *
 * Server-side proxy for USFWS National Wetlands Inventory WMS tiles.
 *
 * The FWS ArcGIS server enforces CORP/referrer policies that block browsers
 * from loading cross-origin images when the requesting page is a third-party
 * site. Proxying through our own Vercel function means the browser fetches
 * tiles from coolswamps.com (same origin), bypassing that restriction.
 *
 * Security notes:
 *  - Only WMS GetMap parameters are forwarded; all others are stripped.
 *  - REQUEST is hardcoded to GetMap — callers cannot trigger GetCapabilities
 *    or any other WMS operation through this proxy.
 *  - Responses are cached at the CDN edge for 24 h to reduce upstream load.
 */

const UPSTREAM =
  'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/services/Wetlands/MapServer/WMSServer';

// Only WMS GetMap parameters are forwarded.
const ALLOWED = new Set([
  'version', 'layers', 'styles', 'crs', 'srs',
  'bbox', 'width', 'height', 'format', 'transparent',
  'bgcolor', 'exceptions', 'time', 'elevation',
]);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }

  const params = new URLSearchParams();
  params.set('SERVICE', 'WMS');
  params.set('REQUEST', 'GetMap');

  for (const [k, v] of Object.entries(req.query)) {
    if (ALLOWED.has(k.toLowerCase())) {
      params.set(k, String(v));
    }
  }

  try {
    const upstream = await fetch(`${UPSTREAM}?${params}`, {
      headers: {
        'User-Agent': 'CoolSwamps/1.0 (+https://coolswamps.com)',
        'Referer': 'https://coolswamps.com/',
      },
    });

    const contentType = upstream.headers.get('content-type') ?? 'image/png';
    const buf = Buffer.from(await upstream.arrayBuffer());

    res
      .status(upstream.status)
      .setHeader('Content-Type', contentType)
      .setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600')
      .end(buf);
  } catch {
    res.status(502).end();
  }
}
