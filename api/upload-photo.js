/**
 * /api/upload-photo
 *
 * Accepts a single photo, validates it, strips EXIF with sharp, creates a
 * GitHub blob, and returns { sha, filename }. The main form submission then
 * references photos by SHA rather than sending binary data inline — this
 * sidesteps Vercel's 4.5 MB serverless payload cap entirely, so any number
 * of photos can be submitted regardless of their combined size.
 */

const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN ?? 'https://coolswamps.com';
const GITHUB_PAT      = process.env.GITHUB_PAT;
const REPO_OWNER      = process.env.GITHUB_REPO_OWNER ?? 'coolswamps';
const REPO_NAME       = process.env.GITHUB_REPO_NAME  ?? 'coolswamps';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME    = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Hard cap matching the per-submission photo limit — prevents uploading more
// blobs than can ever appear in a single PR regardless of client behaviour.
const RATE_LIMIT_MAX = 10;

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

function isValidImageBuffer(buf, mimeType) {
  const bytes = new Uint8Array(buf);
  if (mimeType === 'image/jpeg') return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (mimeType === 'image/png')  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  if (mimeType === 'image/webp') {
    const header = new TextDecoder().decode(bytes.slice(0, 12));
    return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  }
  return false;
}

async function githubFetch(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      'Authorization':        `Bearer ${GITHUB_PAT}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           'CoolSwamps-Upload-Bot/1.0',
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const requestOrigin = req.headers['origin'];
  if (requestOrigin && requestOrigin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!GITHUB_PAT) return res.status(500).json({ error: 'Server configuration error' });

  const clientIp =
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many uploads. Please wait before trying again.' });
  }

  // Parse single photo
  let photoFiles;
  try {
    const { default: formidable } = await import('formidable');
    const form = formidable({
      maxFiles:    1,
      maxFileSize: MAX_PHOTO_BYTES,
      filter:      ({ mimetype }) => ALLOWED_MIME.has(mimetype ?? ''),
      keepExtensions: false,
    });
    [, photoFiles] = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, files) => err ? reject(err) : resolve([f, files]));
    });
  } catch (err) {
    console.error('Upload parse error:', err);
    return res.status(400).json({ error: 'Invalid upload.' });
  }

  const allFiles = Object.values(photoFiles).flat();
  if (allFiles.length === 0) return res.status(400).json({ error: 'No photo provided.' });

  const file = allFiles[0];

  const { default: sharp } = await import('sharp');
  const { readFile }       = await import('fs/promises');
  const { randomBytes }    = await import('crypto');

  const buf = await readFile(file.filepath);

  if (!isValidImageBuffer(buf, file.mimetype)) {
    return res.status(400).json({ error: 'Invalid image file.' });
  }

  let cleanBuf;
  try {
    cleanBuf = await sharp(buf, { limitInputPixels: 24_000_000, failOn: 'error' })
      .rotate()
      .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.error('Sharp processing error:', err);
    return res.status(400).json({ error: 'Could not process image.' });
  }

  const filename = `${randomBytes(8).toString('hex')}.jpg`;

  try {
    const blob = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/blobs`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: cleanBuf.toString('base64'), encoding: 'base64' }),
    });
    return res.status(200).json({ sha: blob.sha, filename });
  } catch (err) {
    console.error('GitHub blob creation error:', err);
    return res.status(500).json({ error: 'Failed to store photo. Please try again.' });
  }
}
