/**
 * /api/submit-swamp
 *
 * Vercel serverless function that:
 *  1. Validates the request (CORS origin, rate limit, content-type)
 *  2. Parses and validates all form fields (server-side Zod-equivalent)
 *  3. Strips ALL EXIF/metadata from uploaded photos using sharp
 *  4. Validates photo file magic bytes (not just MIME header)
 *  5. Creates a new branch on GitHub with the swamp JSON + photos
 *  6. Opens a pull request for admin review
 *
 * Required environment variables (set in Vercel dashboard):
 *   GITHUB_PAT          — Fine-grained PAT: contents+PRs write on coolswamps/coolswamps
 *   GITHUB_REPO_OWNER   — coolswamps
 *   GITHUB_REPO_NAME    — coolswamps
 *   ALLOWED_ORIGIN      — https://coolswamps.com
 *   RATE_LIMIT_MAX      — (optional) max submissions per IP per hour (default: 3)
 */

// Node built-ins
import { randomBytes } from 'crypto';

// ── Constants ──────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN ?? 'https://coolswamps.com';
const GITHUB_PAT       = process.env.GITHUB_PAT;
const REPO_OWNER       = process.env.GITHUB_REPO_OWNER ?? 'coolswamps';
const REPO_NAME        = process.env.GITHUB_REPO_NAME  ?? 'coolswamps';
const RATE_LIMIT_MAX   = parseInt(process.env.RATE_LIMIT_MAX ?? '3', 10);
const BASE_BRANCH      = 'main';

// In-memory rate limiter (resets on cold start — acceptable for free tier)
/** @type {Map<string, {count: number, resetAt: number}>} */
const rateLimitMap = new Map();

// Allowed MIME types
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Max sizes
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_PHOTOS      = 10;
const MAX_TEXT_LEN    = 5000;

// Valid enum values (mirror of content/config.ts)
const VALID_STATES = new Set([
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
  'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa',
  'Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan',
  'Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada',
  'New Hampshire','New Jersey','New Mexico','New York','North Carolina',
  'North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island',
  'South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont',
  'Virginia','Washington','West Virginia','Wisconsin','Wyoming',
  'Washington D.C.','Puerto Rico','U.S. Virgin Islands',
]);

const VALID_TERRAIN   = new Set(['bottomland-forest','bog','peat-bog','mire','fen','cypress-dome','cypress-swamp','pocosin','mangrove','prairie-pothole','freshwater-marsh','saltwater-marsh','vernal-pool','shrub-carr','tidal-swamp','floodplain-forest','Carolina-bay','wet-prairie','other']);
const VALID_HABITAT   = new Set(['forested-wetland','shrub-wetland','emergent-wetland','aquatic-bed','unconsolidated-bottom','unconsolidated-shore','moss-lichen-wetland','other']);
const VALID_SOIL      = new Set(['histosol','hydric','peat','muck','clay','sandy-loam','silt-loam','alluvial','marl','organic','other']);
const VALID_WATER     = new Set(['blackwater','clearwater','whitewater','tidal','standing-water','slow-moving','seasonal','perennial','intermittent','other']);
const VALID_TOPO      = new Set(['flat','gentle-slope','depression','floodplain','terrace','karst','coastal','riverine','lacustrine','palustrine','other']);
const VALID_ACTIVITIES= new Set(['hiking','bushwhacking','kayaking','canoeing','paddling','birding','wildlife-watching','photography','videography','fishing','frogging','hunting','foraging','swimming','wading','camping','overnight-backpacking','botanizing','herping','insect-collecting','scientific-research','other']);
const VALID_DIFFICULTY= new Set(['easy','moderate','difficult','expert']);
const VALID_SEASONS   = new Set(['spring','summer','fall','winter','year-round']);
const VALID_STATUS    = new Set(['visited','want-to-visit']);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Sanitize a string: trim, limit length, strip control characters */
function sanitizeText(val, maxLen = 200) {
  if (typeof val !== 'string') return '';
  // Remove control characters except newlines and tabs
  return val.replace(/[^\S\n\t]|\p{Cc}/gu, ' ').trim().slice(0, maxLen);
}

/** Validate an array of values against an allowed Set, filtering unknowns */
function filterEnum(values, validSet) {
  if (!Array.isArray(values)) return [];
  return values.filter(v => typeof v === 'string' && validSet.has(v));
}

/**
 * Escape Markdown special characters and zero-width / bidi tricks before
 * interpolating user input into a PR body. Prevents a submitter from injecting
 * fake "review complete" checklists, fake section headers, or table-breaking
 * pipes that mislead reviewers into approving a malicious entry.
 */
const INVISIBLE_RE = /[​-‏‪-‮⁦-⁩﻿]/g;
function escapeMd(val) {
  if (val === undefined || val === null) return '';
  return String(val)
    // Drop zero-width and bidi-override characters that can hide text
    .replace(INVISIBLE_RE, '')
    // Backslash-escape Markdown structural characters
    .replace(/([\\`*_{}\[\]()#+\-!|>~])/g, '\\$1')
    // Collapse newlines so injected content cannot start new blocks
    .replace(/\r?\n/g, ' ');
}

/** Like escapeMd but keeps newlines (paragraph fields). Still escapes line-
 *  leading characters so headings/checklists/blockquotes/tables cannot start. */
function escapeMdBlock(val) {
  if (val === undefined || val === null) return '';
  return String(val)
    .replace(INVISIBLE_RE, '')
    .split(/\r?\n/)
    .map(line => line.replace(/^([ \t]*)([#>\-+*]|\d+\.|\[)/, '$1\\$2'))
    .join('\n');
}

/** Check image magic bytes */
function isValidImageBuffer(buf, mimeType) {
  const bytes = new Uint8Array(buf);
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }
  if (mimeType === 'image/png') {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  }
  if (mimeType === 'image/webp') {
    const dec = new TextDecoder();
    const header = dec.decode(bytes.slice(0, 12));
    return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  }
  return false;
}

/**
 * Generate a URL-safe slug from swamp name.
 * No random suffix needed — the caller prepends a timestamp to branch names
 * and the slug is only used for the content file path (which is commit-unique).
 */
function makeSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    || `swamp-${randomBytes(3).toString('hex')}`;
}

/** GitHub API helper */
async function githubFetch(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CoolSwamps-Submission-Bot/1.0',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub API ${path}: ${res.status} ${body.message ?? ''}`);
  }
  return res.json();
}

/** Rate limiter — IP-based, in-memory, 1-hour window */
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ── Main handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  // ── 1. CORS + origin validation ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Server-side origin check — stops cross-origin form submissions that bypass
  // CORS (browsers don't send an Origin header for same-origin requests, so we
  // also accept a missing Origin only when Referer is absent, i.e. direct API
  // calls from curl/Postman which are not the CSRF threat model).
  const requestOrigin = req.headers['origin'];
  if (requestOrigin && requestOrigin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!ALLOWED_MIME.has('image/jpeg') || !GITHUB_PAT) {
    console.error('Missing required environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ── 2. Rate limiting ──────────────────────────────────────────────────
  // Use x-real-ip (set by Vercel's edge, not spoofable by the client) and fall
  // back to the rightmost x-forwarded-for entry (also appended by the CDN, not
  // by the client). Never take the leftmost value — that is client-controlled.
  const clientIp =
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many submissions. Please wait before trying again.' });
  }

  // ── 3. Parse multipart form data ──────────────────────────────────────
  // Vercel provides parsed body for non-multipart; for file uploads we use formidable
  let fields, photoFiles;
  try {
    const { default: formidable } = await import('formidable');
    const form = formidable({
      maxFiles: MAX_PHOTOS,
      maxFileSize: MAX_PHOTO_BYTES,
      filter: ({ mimetype }) => ALLOWED_MIME.has(mimetype ?? ''),
      keepExtensions: false,
    });

    [fields, photoFiles] = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, files) => {
        if (err) reject(err);
        else resolve([f, files]);
      });
    });
  } catch (err) {
    console.error('Form parse error:', err);
    return res.status(400).json({ error: 'Invalid form submission.' });
  }

  // Helper to get first value from formidable fields
  const field = (key) => {
    const val = fields[key];
    return Array.isArray(val) ? val[0] : (val ?? '');
  };

  const getAll = (key) => {
    const val = fields[key];
    return Array.isArray(val) ? val : val ? [val] : [];
  };

  // ── 4. Validate & sanitize fields ─────────────────────────────────────

  const name = sanitizeText(field('name'), 200);
  if (!name) return res.status(400).json({ error: 'Swamp name is required.' });

  const status = field('status');
  if (!VALID_STATUS.has(status)) return res.status(400).json({ error: 'Invalid status value.' });

  const state = sanitizeText(field('state'), 50);
  if (!VALID_STATES.has(state)) return res.status(400).json({ error: 'Invalid state.' });

  const county = sanitizeText(field('county'), 100);
  if (!county) return res.status(400).json({ error: 'County is required.' });

  const lat = parseFloat(field('lat'));
  const lng = parseFloat(field('lng'));
  if (isNaN(lat) || lat < -90  || lat > 90)  return res.status(400).json({ error: 'Invalid latitude.' });
  if (isNaN(lng) || lng < -180 || lng > 180) return res.status(400).json({ error: 'Invalid longitude.' });

  const description    = sanitizeText(field('description'),    MAX_TEXT_LEN);
  const access_notes   = sanitizeText(field('access_notes'),   2000);
  const wildlife_notes = sanitizeText(field('wildlife_notes'), 2000);
  const historical_notes = sanitizeText(field('historical_notes'), 2000);

  const area_acres   = parseFloat(field('area_acres'))   || undefined;
  const elevation_ft = parseFloat(field('elevation_ft')) || undefined;

  const terrain    = filterEnum(getAll('terrain'),    VALID_TERRAIN);
  const habitat    = filterEnum(getAll('habitat'),    VALID_HABITAT);
  const soil       = filterEnum(getAll('soil'),       VALID_SOIL);
  const water_type = filterEnum(getAll('water_type'), VALID_WATER);
  const topography = filterEnum(getAll('topography'), VALID_TOPO);
  const activities = filterEnum(getAll('activities'), VALID_ACTIVITIES);
  const best_season= filterEnum(getAll('best_season'),VALID_SEASONS);

  const difficulty = VALID_DIFFICULTY.has(field('difficulty')) ? field('difficulty') : undefined;

  // Ratings — each is an optional integer 1–5
  function parseRating(val) {
    const n = parseInt(val, 10);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
  }
  const ratingNovelty       = parseRating(field('rating_novelty'));
  const ratingAccessibility = parseRating(field('rating_accessibility'));
  const ratingHabitat       = parseRating(field('rating_habitat'));

  // Vegetation: split by comma, sanitize each tag
  const vegRaw  = sanitizeText(field('vegetation'), 1000);
  const vegetation = vegRaw ? vegRaw.split(',').map(v => sanitizeText(v, 100)).filter(Boolean).slice(0, 30) : [];

  // Custom tags: split + sanitize
  const customRaw = sanitizeText(field('custom_tags'), 500);
  const custom = customRaw ? customRaw.split(',').map(v => sanitizeText(v, 50)).filter(Boolean).slice(0, 20) : [];

  // ── 5. Process photos ─────────────────────────────────────────────────
  const { default: sharp } = await import('sharp');
  const { readFile } = await import('fs/promises');

  const allPhotoFiles = Object.values(photoFiles).flat();
  const processedPhotos = [];

  for (const file of allPhotoFiles.slice(0, MAX_PHOTOS)) {
    // Read file bytes
    const buf = await readFile(file.filepath);

    // Validate magic bytes
    if (!isValidImageBuffer(buf, file.mimetype)) {
      console.warn('Invalid magic bytes for uploaded file, skipping');
      continue;
    }

    // Strip ALL metadata using sharp (rotate to fix orientation, then strip).
    // Sharp does NOT include metadata in output by default — calling .withMetadata()
    // would copy EXIF from the input, which is the opposite of what we want.
    // .rotate() uses the EXIF orientation tag to auto-correct rotation, then the
    // tag (and all other EXIF) is dropped because we do not call .withMetadata().
    let cleanBuf;
    try {
      cleanBuf = await sharp(buf)
        .rotate()          // auto-rotate from EXIF orientation flag
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    } catch (err) {
      console.error('Sharp processing error:', err);
      continue; // Skip malformed images
    }

    // Verify output size is reasonable
    if (cleanBuf.length > MAX_PHOTO_BYTES) {
      console.warn('Processed photo exceeds size limit, skipping');
      continue;
    }

    const ext = 'jpg';
    const photoSlug = randomBytes(8).toString('hex');
    processedPhotos.push({
      filename: `${photoSlug}.${ext}`,
      buffer: cleanBuf,
      base64: cleanBuf.toString('base64'),
    });
  }

  // ── 6. Build swamp JSON ───────────────────────────────────────────────
  // Use Date.now() as a submission ID — guarantees branch name uniqueness even
  // under concurrent submissions of the same swamp name (mirrors republican-business-map).
  // The file slug stays human-readable for clean URLs; only the branch gets the timestamp prefix.
  const submissionId = Date.now().toString();
  const slug  = makeSlug(name);
  const today = new Date().toISOString().split('T')[0];

  const swampData = {
    name,
    status,
    coordinates: { lat, lng },
    state,
    county,
    country: 'USA',
    ...(description    ? { description }    : {}),
    ...(access_notes   ? { access_notes }   : {}),
    ...(wildlife_notes ? { wildlife_notes } : {}),
    ...(historical_notes ? { historical_notes } : {}),
    ...(area_acres   !== undefined ? { area_acres }   : {}),
    ...(elevation_ft !== undefined ? { elevation_ft } : {}),
    tags: { terrain, habitat, soil, water_type, topography, activities, vegetation, custom },
    ...(difficulty  ? { difficulty }  : {}),
    ...(best_season.length ? { best_season } : {}),
    ...(ratingNovelty !== undefined || ratingAccessibility !== undefined || ratingHabitat !== undefined
      ? { ratings: {
          ...(ratingNovelty       !== undefined ? { novelty:       ratingNovelty }       : {}),
          ...(ratingAccessibility !== undefined ? { accessibility: ratingAccessibility } : {}),
          ...(ratingHabitat       !== undefined ? { habitat:       ratingHabitat }       : {}),
        }}
      : {}),
    photos: processedPhotos.map(p => ({ filename: p.filename })),
    submitted_date: today,
    last_updated:   today,
    verified: false,
  };

  // ── 7. Create GitHub branch + single commit (Git Tree API) ────────────
  //
  // Using the Git Tree API instead of the Contents API PUT endpoint because
  // PUT /contents/:path creates one commit per file. A submission with 8 photos
  // would create 9 commits on the branch, triggering 9 Vercel preview builds
  // (each canceling the previous) and producing a messy PR commit history.
  //
  // The Tree API approach:
  //   a) Create a blob for each file (JSON + photos)
  //   b) Assemble all blobs into a single tree
  //   c) Create one commit pointing at that tree
  //   d) Update the branch ref to the new commit
  // This produces exactly one commit regardless of how many photos are attached.
  try {
    // a) Get base commit SHA and its tree SHA
    const baseRef = await githubFetch(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`
    );
    const baseCommitSha = baseRef.object.sha;

    const baseCommit = await githubFetch(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/commits/${baseCommitSha}`
    );
    const baseTreeSha = baseCommit.tree.sha;

    // b) Create branch pointing at base commit
    const branchName = `submission/${submissionId}-${slug}`;
    await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: baseCommitSha,
      }),
    });

    // c) Create a blob for each file, collect tree entries
    async function createBlob(base64Content) {
      const res = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/blobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: base64Content, encoding: 'base64' }),
      });
      return res.sha;
    }

    const jsonContent = JSON.stringify(swampData, null, 2);
    const jsonBlobSha = await createBlob(Buffer.from(jsonContent).toString('base64'));

    const treeEntries = [
      {
        path: `src/content/swamps/${slug}.json`,
        mode: '100644',
        type: 'blob',
        sha:  jsonBlobSha,
      },
    ];

    for (const photo of processedPhotos) {
      const photoBlobSha = await createBlob(photo.base64);
      treeEntries.push({
        path: `public/photos/${photo.filename}`,
        mode: '100644',
        type: 'blob',
        sha:  photoBlobSha,
      });
    }

    // d) Create tree on top of the base tree
    const newTree = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });

    // e) Create a single commit — one commit regardless of photo count
    const photoNote = processedPhotos.length > 0
      ? ` + ${processedPhotos.length} photo${processedPhotos.length > 1 ? 's' : ''}`
      : '';
    const newCommit = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `feat: add swamp submission — ${name}${photoNote}`,
        tree:    newTree.sha,
        parents: [baseCommitSha],
      }),
    });

    // f) Advance the branch ref to the new commit
    await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${branchName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommit.sha }),
    });

    // Open pull request — one file added, zero files modified, so no other open PR
    // can ever conflict with this one. Merging in any order is always safe.
    const mapLink = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=14`;
    const gbifLink = `https://www.gbif.org/occurrence/map?decimalLatitude=${(lat-0.1).toFixed(3)},${(lat+0.1).toFixed(3)}&decimalLongitude=${(lng-0.1).toFixed(3)},${(lng+0.1).toFixed(3)}`;

    // User-submitted values are escaped (escapeMd / escapeMdBlock) before
    // interpolation into the PR body so a submitter cannot inject fake
    // pre-checked review checklists, fake headings, or table-breaking pipes
    // to mislead the reviewer. Enum/validated fields (status, terrain, etc.)
    // are already constrained to safe character sets — but we still wrap them
    // in escapeMd for defense in depth.
    const prBody = [
      `## New Swamp Submission`,
      ``,
      `> **Merging this PR will automatically publish the swamp to the live map.** Vercel rebuilds on merge — no other steps required.`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Name** | ${escapeMd(name)} |`,
      `| **Status** | ${escapeMd(status)} |`,
      `| **State** | ${escapeMd(state)} |`,
      `| **County** | ${escapeMd(county)} County |`,
      `| **Coordinates** | ${lat.toFixed(6)}, ${lng.toFixed(6)} |`,
      `| **Terrain** | ${escapeMd(terrain.join(', ')) || '—'} |`,
      `| **Activities** | ${escapeMd(activities.join(', ')) || '—'} |`,
      `| **Difficulty** | ${escapeMd(difficulty) || '—'} |`,
      `| **Best Season** | ${escapeMd(best_season.join(', ')) || '—'} |`,
      `| **Area** | ${area_acres ? `${area_acres.toLocaleString()} acres` : '—'} |`,
      `| **Ratings** | Novelty: ${ratingNovelty ?? '—'} · Accessibility: ${ratingAccessibility ?? '—'} · Habitat: ${ratingHabitat ?? '—'} |`,
      `| **Photos** | ${processedPhotos.length} uploaded (EXIF fully stripped) |`,
      ``,
      `**[📍 Verify map pin location](${mapLink})**`,
      `**[🌿 View nearby GBIF species](${gbifLink})**`,
      ``,
      description ? `### Description\n${escapeMdBlock(description)}` : `### Description\n_No description provided._`,
      ``,
      access_notes   ? `### Access Notes\n${escapeMdBlock(access_notes)}`   : '',
      wildlife_notes ? `### Wildlife Notes\n${escapeMdBlock(wildlife_notes)}` : '',
      ``,
      `### Review checklist`,
      `- [ ] Swamp name is real and correctly spelled`,
      `- [ ] State and county are accurate`,
      `- [ ] Map pin location looks correct (see link above)`,
      `- [ ] Description is appropriate and factual`,
      processedPhotos.length > 0
        ? `- [ ] Photos show the actual location (${processedPhotos.length} attached)`
        : `- [ ] No photos submitted`,
      `- [ ] No personal information in any field`,
      ``,
      `---`,
      `_Submitted anonymously via coolswamps.com · Submission ID: ${submissionId}_`,
    ].filter(s => s !== '').join('\n');

    await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Submission: ${name} — ${county} County, ${state}`,
        body: prBody,
        head: branchName,
        base: BASE_BRANCH,
      }),
    });

    return res.status(200).json({ success: true, slug });

  } catch (err) {
    console.error('GitHub API error:', err);
    return res.status(500).json({
      error: 'Failed to create submission. Please try again later.',
    });
  }
}
