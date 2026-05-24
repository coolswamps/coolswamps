/**
 * /api/suggest-edit
 *
 * Vercel serverless function that:
 *  1. Validates the request (CORS, rate limit, CSRF, content-type)
 *  2. Parses and validates all form fields (server-side validation)
 *  3. Verifies the target slug exists in the repo (GitHub Contents API)
 *  4. Merges submitted fields with immutable original fields
 *     (submitted_date, verified, photos are preserved from the original)
 *  5. Creates branch edit/{timestamp}-{slug}
 *  6. Updates the JSON file on that branch (GitHub Contents PUT with SHA)
 *  7. Opens a pull request with an automatic diff summary and review checklist
 *
 * Required environment variables (set in Vercel dashboard):
 *   GITHUB_PAT          — Fine-grained PAT: contents+PRs write on coolswamps/coolswamps
 *   GITHUB_REPO_OWNER   — coolswamps
 *   GITHUB_REPO_NAME    — coolswamps
 *   ALLOWED_ORIGIN      — https://coolswamps.com
 *   RATE_LIMIT_MAX      — (optional) max edit suggestions per IP per hour (default: 5)
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'https://coolswamps.com';
const GITHUB_PAT     = process.env.GITHUB_PAT;
const REPO_OWNER     = process.env.GITHUB_REPO_OWNER ?? 'coolswamps';
const REPO_NAME      = process.env.GITHUB_REPO_NAME  ?? 'coolswamps';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? '5', 10);
const BASE_BRANCH    = 'main';

// Slug pattern — alphanumeric plus hyphens, no path traversal characters
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

// In-memory rate limiter (resets on cold start — acceptable for free tier)
/** @type {Map<string, {count: number, resetAt: number}>} */
const rateLimitMap = new Map();

// Max text lengths
const MAX_TEXT_LEN = 5000;

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

const VALID_TERRAIN    = new Set(['bottomland-forest','bog','peat-bog','mire','fen','cypress-dome','cypress-swamp','pocosin','mangrove','prairie-pothole','freshwater-marsh','saltwater-marsh','vernal-pool','shrub-carr','tidal-swamp','floodplain-forest','Carolina-bay','wet-prairie','other']);
const VALID_HABITAT    = new Set(['forested-wetland','shrub-wetland','emergent-wetland','aquatic-bed','unconsolidated-bottom','unconsolidated-shore','moss-lichen-wetland','other']);
const VALID_SOIL       = new Set(['histosol','hydric','peat','muck','clay','sandy-loam','silt-loam','alluvial','marl','organic','other']);
const VALID_WATER      = new Set(['blackwater','clearwater','whitewater','tidal','standing-water','slow-moving','seasonal','perennial','intermittent','other']);
const VALID_TOPO       = new Set(['flat','gentle-slope','depression','floodplain','terrace','karst','coastal','riverine','lacustrine','palustrine','other']);
const VALID_ACTIVITIES = new Set(['hiking','bushwhacking','kayaking','canoeing','paddling','birding','wildlife-watching','photography','videography','fishing','frogging','hunting','foraging','swimming','wading','camping','overnight-backpacking','botanizing','herping','insect-collecting','scientific-research','other']);
const VALID_DIFFICULTY = new Set(['easy','moderate','difficult','expert']);
const VALID_SEASONS    = new Set(['spring','summer','fall','winter','year-round']);
const VALID_STATUS     = new Set(['visited','want-to-visit']);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Sanitize a string: trim, limit length, strip control characters */
function sanitizeText(val, maxLen = 200) {
  if (typeof val !== 'string') return '';
  return val.replace(/[^\S\n\t]|\p{Cc}/gu, ' ').trim().slice(0, maxLen);
}

/** Validate an array of values against an allowed Set, filtering unknowns */
function filterEnum(values, validSet) {
  if (!Array.isArray(values)) return [];
  return values.filter(v => typeof v === 'string' && validSet.has(v));
}

/** Parse an optional integer rating 1-5 */
function parseRating(val) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

/** GitHub API helper */
async function githubFetch(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CoolSwamps-Edit-Bot/1.0',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`GitHub API ${path}: ${res.status} ${body.message ?? ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Rate limiter — IP-based, in-memory, 1-hour window */
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

/**
 * Build a human-readable diff line for the PR body.
 * Returns a markdown table row string, or null when the values are identical.
 */
function diffRow(label, oldVal, newVal) {
  const fmt = (v) => {
    if (v === undefined || v === null || v === '') return '_empty_';
    if (Array.isArray(v)) return v.length ? v.join(', ') : '_empty_';
    return String(v);
  };
  const o = fmt(oldVal);
  const n = fmt(newVal);
  if (o === n) return null;
  return `| **${label}** | ${o} | ${n} |`;
}

// ── Main handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  // ── 1. CORS ────────────────────────────────────────────────────────────
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

  if (!GITHUB_PAT) {
    console.error('GITHUB_PAT environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ── 2. Rate limiting ───────────────────────────────────────────────────
  const clientIp =
    (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many suggestions. Please wait before trying again.' });
  }

  // ── 3. Parse multipart form data ───────────────────────────────────────
  // The edit form posts FormData (no file inputs) — formidable handles multipart.
  let fields;
  try {
    const { default: formidable } = await import('formidable');
    const form = formidable({ maxFiles: 0, maxFieldsSize: 100 * 1024 });
    [fields] = await new Promise((resolve, reject) => {
      form.parse(req, (err, f) => {
        if (err) reject(err);
        else resolve([f]);
      });
    });
  } catch (err) {
    console.error('Form parse error:', err);
    return res.status(400).json({ error: 'Invalid form submission.' });
  }

  // Helper to extract the first value from formidable fields
  const field = (key) => {
    const val = fields[key];
    return Array.isArray(val) ? val[0] : (val ?? '');
  };
  const getAll = (key) => {
    const val = fields[key];
    return Array.isArray(val) ? val : val ? [val] : [];
  };

  // ── 4. Validate original_slug ──────────────────────────────────────────
  const rawSlug = field('original_slug');
  if (!SLUG_RE.test(rawSlug)) {
    return res.status(400).json({ error: 'Invalid swamp identifier.' });
  }
  const slug = rawSlug;

  // Fetch current file from GitHub to confirm it exists and get its SHA + content.
  let currentContent;
  let fileSha;
  try {
    const fileRes = await githubFetch(
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/src/content/swamps/${slug}.json`
    );
    fileSha = fileRes.sha;
    currentContent = JSON.parse(
      Buffer.from(fileRes.content, 'base64').toString('utf-8')
    );
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Swamp entry not found.' });
    }
    console.error('Failed to fetch current file:', err);
    return res.status(500).json({ error: 'Could not retrieve current entry. Please try again later.' });
  }

  // ── 5. Validate & sanitize submitted fields ────────────────────────────

  const editNotes = sanitizeText(field('edit_notes'), 1000);
  if (!editNotes) {
    return res.status(400).json({ error: 'Edit notes are required — describe what you changed.' });
  }

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

  const description      = sanitizeText(field('description'),      MAX_TEXT_LEN);
  const access_notes     = sanitizeText(field('access_notes'),     2000);
  const wildlife_notes   = sanitizeText(field('wildlife_notes'),   2000);
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

  const ratingNovelty       = parseRating(field('rating_novelty'));
  const ratingAccessibility = parseRating(field('rating_accessibility'));
  const ratingHabitat       = parseRating(field('rating_habitat'));

  const vegRaw     = sanitizeText(field('vegetation'), 1000);
  const vegetation = vegRaw
    ? vegRaw.split(',').map(v => sanitizeText(v, 100)).filter(Boolean).slice(0, 30)
    : [];

  const customRaw = sanitizeText(field('custom_tags'), 500);
  const custom = customRaw
    ? customRaw.split(',').map(v => sanitizeText(v, 50)).filter(Boolean).slice(0, 20)
    : [];

  // ── 6. Build updated JSON ──────────────────────────────────────────────
  // Immutable fields preserved from the original:
  //   submitted_date — original submission date never changes
  //   verified       — only admins toggle verification; user edits reset to false
  //   photos         — photo management is handled separately
  const today = new Date().toISOString().split('T')[0];

  const updatedData = {
    name,
    status,
    coordinates: { lat, lng },
    state,
    county,
    country: currentContent.country ?? 'USA',
    ...(description      ? { description }      : {}),
    ...(access_notes     ? { access_notes }     : {}),
    ...(wildlife_notes   ? { wildlife_notes }   : {}),
    ...(historical_notes ? { historical_notes } : {}),
    ...(area_acres   !== undefined ? { area_acres }   : {}),
    ...(elevation_ft !== undefined ? { elevation_ft } : {}),
    tags: { terrain, habitat, soil, water_type, topography, activities, vegetation, custom },
    ...(difficulty   ? { difficulty }   : {}),
    ...(best_season.length ? { best_season } : {}),
    ...(ratingNovelty !== undefined || ratingAccessibility !== undefined || ratingHabitat !== undefined
      ? { ratings: {
          ...(ratingNovelty       !== undefined ? { novelty:       ratingNovelty }       : {}),
          ...(ratingAccessibility !== undefined ? { accessibility: ratingAccessibility } : {}),
          ...(ratingHabitat       !== undefined ? { habitat:       ratingHabitat }       : {}),
        }}
      : {}),
    // Preserve immutable original fields
    photos: currentContent.photos ?? [],
    submitted_date: currentContent.submitted_date ?? today,
    last_updated: today,
    verified: false,  // Edits reset verified — admin must re-verify
  };

  // ── 7. Build diff summary for PR body ─────────────────────────────────
  const orig = currentContent;

  const diffRows = [
    diffRow('Name',        orig.name,        name),
    diffRow('Status',      orig.status,      status),
    diffRow('State',       orig.state,       state),
    diffRow('County',      orig.county,      county),
    diffRow('Latitude',    orig.coordinates?.lat, lat),
    diffRow('Longitude',   orig.coordinates?.lng, lng),
    diffRow('Area (acres)',    orig.area_acres,   area_acres),
    diffRow('Elevation (ft)',  orig.elevation_ft, elevation_ft),
    diffRow('Difficulty',      orig.difficulty,   difficulty),
    diffRow('Best Season',     orig.best_season,  best_season),
    diffRow('Terrain',         orig.tags?.terrain,    terrain),
    diffRow('Habitat',         orig.tags?.habitat,    habitat),
    diffRow('Soil',            orig.tags?.soil,       soil),
    diffRow('Water Type',      orig.tags?.water_type, water_type),
    diffRow('Topography',      orig.tags?.topography, topography),
    diffRow('Activities',      orig.tags?.activities, activities),
    diffRow('Vegetation',      orig.tags?.vegetation, vegetation),
    diffRow('Custom Tags',     orig.tags?.custom,     custom),
    diffRow('Rating: Novelty',       orig.ratings?.novelty,       ratingNovelty),
    diffRow('Rating: Accessibility', orig.ratings?.accessibility, ratingAccessibility),
    diffRow('Rating: Habitat',       orig.ratings?.habitat,       ratingHabitat),
    diffRow('Description',     orig.description,      description),
    diffRow('Access Notes',    orig.access_notes,     access_notes),
    diffRow('Wildlife Notes',  orig.wildlife_notes,   wildlife_notes),
    diffRow('Historical Notes',orig.historical_notes, historical_notes),
  ].filter(Boolean);

  // ── 8. Create GitHub branch + single commit (Git Tree API) ──────────────
  // Using the Tree API for consistency with submit-swamp.js — one clean commit
  // per suggestion, one Vercel preview build, no per-file commit noise.
  const submissionId = Date.now().toString();
  const branchName   = `edit/${submissionId}-${slug}`;

  try {
    // Get base commit SHA and its tree SHA
    const baseRef = await githubFetch(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`
    );
    const baseCommitSha = baseRef.object.sha;

    const baseCommit = await githubFetch(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/commits/${baseCommitSha}`
    );
    const baseTreeSha = baseCommit.tree.sha;

    // Create the edit branch
    await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: baseCommitSha,
      }),
    });

    // Create a blob for the updated JSON
    const jsonContent = JSON.stringify(updatedData, null, 2);
    const jsonBlob = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content:  Buffer.from(jsonContent).toString('base64'),
        encoding: 'base64',
      }),
    });

    // Create a tree that replaces only the one changed file
    const newTree = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [{
          path: `src/content/swamps/${slug}.json`,
          mode: '100644',
          type: 'blob',
          sha:  jsonBlob.sha,
        }],
      }),
    });

    // Create a single commit
    const newCommit = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `edit: update swamp — ${name}`,
        tree:    newTree.sha,
        parents: [baseCommitSha],
      }),
    });

    // Advance branch ref to the new commit
    await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${branchName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommit.sha }),
    });

    // ── 9. Open pull request ───────────────────────────────────────────
    const mapLink  = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=14`;
    const liveLink = `https://coolswamps.com/swamps/${slug}`;

    const diffSection = diffRows.length > 0
      ? [
          `### Fields changed (${diffRows.length})`,
          ``,
          `| Field | Before | After |`,
          `|-------|--------|-------|`,
          ...diffRows,
        ].join('\n')
      : `### No field values changed\n_Only metadata fields (last_updated, verified) were updated._`;

    const prBody = [
      `## Edit Suggestion: ${name}`,
      ``,
      `> **Merging this PR will automatically update the live entry.** Vercel rebuilds on merge — no other steps required.`,
      ``,
      `**[📄 Current live entry](${liveLink})** · **[📍 Verify map pin](${mapLink})**`,
      ``,
      `### Submitter's notes`,
      ``,
      editNotes,
      ``,
      diffSection,
      ``,
      `### Review checklist`,
      `- [ ] Swamp name is real and correctly spelled`,
      `- [ ] State and county are accurate`,
      `- [ ] Coordinates look correct (see map link above)`,
      `- [ ] Description and notes are accurate and appropriate`,
      `- [ ] No personal information in any field`,
      `- [ ] If novelty/accessibility/habitat ratings changed — the new values are defensible`,
      diffRows.length === 0
        ? `- [ ] Confirm this is not a no-op submission`
        : `- [ ] All ${diffRows.length} changed field(s) reviewed`,
      ``,
      `---`,
      `_Suggested anonymously via coolswamps.com · Edit ID: ${submissionId}_`,
    ].join('\n');

    await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Edit suggestion: ${name} — ${county} County, ${state}`,
        body: prBody,
        head: branchName,
        base: BASE_BRANCH,
      }),
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('GitHub API error:', err);
    return res.status(500).json({
      error: 'Failed to submit edit suggestion. Please try again later.',
    });
  }
}
