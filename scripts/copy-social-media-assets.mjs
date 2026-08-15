import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const DEFAULT_POSTS = path.join(repoRoot, 'data', 'social-posts.json');
const LINKEDIN_POSTS = path.join(repoRoot, 'data', 'social-posts-linkedin.json');
const DEST_DIR = path.join(repoRoot, 'dist', 'social-media');

const allowedExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.webm'];

function isValidMediaUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.host !== 'www.bathily-convoyage.fr') return false;
    if (!u.pathname.startsWith('/social-media/')) return false;
    const basename = path.basename(u.pathname);
    if (basename !== path.posix.basename(u.pathname)) return false;
    if (basename.startsWith('.') || basename.includes('..')) return false;
    const ext = path.extname(basename).toLowerCase();
    if (!allowedExtensions.includes(ext)) return false;
    return basename;
  } catch {
    return false;
  }
}

async function loadReferencedUrls(...files) {
  const urls = new Set();
  for (const f of files) {
    const posts = JSON.parse(await fs.readFile(f, 'utf8'));
    for (const post of posts) {
      const media = Array.isArray(post.media) ? post.media : [post.media].filter(Boolean);
      for (const item of media) {
        const url = typeof item === 'string' ? item : item?.url;
        if (!url) continue;
        urls.add(url);
      }
    }
  }
  return urls;
}

async function main() {
  const referenced = await loadReferencedUrls(DEFAULT_POSTS, LINKEDIN_POSTS);

  const copied = [];
  const missing = [];

  await fs.mkdir(DEST_DIR, { recursive: true });

  for (const url of referenced) {
    const basename = isValidMediaUrl(url);
    if (!basename) {
      throw new Error(`Invalid or rejected media URL: ${url}`);
    }
    const source = path.join(repoRoot, 'social-media', basename);
    const dest = path.join(DEST_DIR, basename);
    try {
      await fs.copyFile(source, dest);
      copied.push(basename);
    } catch (err) {
      if (err.code === 'ENOENT') {
        missing.push(basename);
      } else {
        throw err;
      }
    }
  }

  if (missing.length > 0) {
    console.error('Missing referenced media files:', missing.join(', '));
    process.exit(1);
  }

  const distEntries = await fs.readdir(DEST_DIR);
  const copiedSet = new Set(copied);
  const extra = distEntries.filter(e => !copiedSet.has(e));
  if (extra.length > 0) {
    console.error('Unexpected extra files in dist/social-media:', extra.join(', '));
    process.exit(1);
  }

  console.log(`Copied ${copied.length} referenced asset(s) to dist/social-media.`);
}

main().catch(err => {
  console.error('Asset copy failed:', err.message);
  process.exit(1);
});
