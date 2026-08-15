import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  getOrganizations,
  getChannels,
  getRecentPostsForChannel,
  createBufferPost
} from './lib/buffer-api.mjs';

const DEFAULT_POSTS_PATH = path.join(process.cwd(), 'data', 'social-posts.json');
const LINKEDIN_POSTS_PATH = path.join(process.cwd(), 'data', 'social-posts-linkedin.json');

function getParisWeekday() {
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long'
  });
  const part = formatter.formatToParts(new Date()).find(p => p.type === 'weekday');
  const french = part.value.toLowerCase();
  const map = {
    dimanche: 'Sunday',
    lundi: 'Monday',
    mardi: 'Tuesday',
    mercredi: 'Wednesday',
    jeudi: 'Thursday',
    vendredi: 'Friday',
    samedi: 'Saturday'
  };
  const english = map[french];
  if (!english) {
    throw new Error(`Unknown Paris weekday: ${part.value}`);
  }
  console.log(`Jour détecté (Europe/Paris) : ${english}`);
  return english;
}

function loadPosts() {
  if (!fs.existsSync(DEFAULT_POSTS_PATH)) {
    throw new Error('Fichier data/social-posts.json introuvable.');
  }
  const defaultPosts = JSON.parse(fs.readFileSync(DEFAULT_POSTS_PATH, 'utf8'));
  const linkedinPosts = fs.existsSync(LINKEDIN_POSTS_PATH)
    ? JSON.parse(fs.readFileSync(LINKEDIN_POSTS_PATH, 'utf8'))
    : defaultPosts;
  return { defaultPosts, linkedinPosts };
}

function buildAssets(todayPost, platform) {
  const assets = [];
  if (todayPost.media) {
    const mediaList = Array.isArray(todayPost.media) ? todayPost.media : [todayPost.media];
    for (const item of mediaList) {
      let urlToUse = typeof item === 'string' ? item : item?.url;
      if (!urlToUse) continue;
      const isVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(urlToUse);

      if (platform === 'tiktok' && !isVideo) {
        console.log('TikTok ignore l\'image sans vidéo.');
        continue;
      }

      assets.push(isVideo ? { video: { url: urlToUse } } : { image: { url: urlToUse } });
    }
  }
  return assets;
}

export function getPlatformMetadata(platform, assets) {
  if (platform === 'instagram') {
    const hasVideo = assets.some(a => a.video);
    return {
      instagram: {
        type: hasVideo ? 'reel' : 'post',
        shouldShareToFeed: true
      }
    };
  }
  if (platform === 'linkedin') {
    return { linkedin: {} };
  }
  if (platform === 'tiktok') {
    return { tiktok: {} };
  }
  return undefined;
}

function maskId(id) {
  if (!id || id.length < 8) return '***';
  return id.slice(0, 3) + '...' + id.slice(-3);
}

function normalizeText(text) {
  return text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function getParisDateString(isoTimestamp) {
  const d = new Date(isoTimestamp);
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

async function findTodayDuplicate({ token, channelId, platform, todayText, todayParisDate, fetchImpl }) {
  const now = new Date();
  const since = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const recent = await getRecentPostsForChannel({ token, channelId, since, fetchImpl });
  const target = normalizeText(todayText);
  for (const post of recent) {
    const postDate = getParisDateString(post.createdAt || post.dueAt);
    if (postDate === todayParisDate && normalizeText(post.text) === target) {
      return true;
    }
  }
  return false;
}

async function resolveChannels(token, configured, fetchImpl) {
  const organizations = await getOrganizations({ token, fetchImpl });
  if (organizations.length === 0) {
    throw new Error('No Buffer organizations found for token.');
  }
  const organizationId = organizations[0].id;
  const channels = await getChannels({ token, organizationId, fetchImpl });
  const byId = new Map();
  for (const ch of channels) {
    byId.set(ch.id, ch.service);
  }

  const resolved = [];
  for (const cfg of configured) {
    const service = byId.get(cfg.id);
    if (!service) {
      throw new Error(`Configured channel not found in Buffer: ${maskId(cfg.id)}`);
    }
    if (service !== cfg.platform) {
      throw new Error(`Channel service mismatch for ${maskId(cfg.id)}: expected ${cfg.platform}, got ${service}`);
    }
    resolved.push({ ...cfg });
  }
  return resolved;
}

export async function publishTodayPost({ live = false, fetchImpl = globalThis.fetch } = {}) {
  const { defaultPosts, linkedinPosts } = loadPosts();
  const todayName = getParisWeekday();

  if (!live) {
    console.log('Mode dry-run : construction du plan de publication.');
    const platforms = ['instagram', 'linkedin', 'tiktok'];
    for (const platform of platforms) {
      const posts = platform === 'linkedin' ? linkedinPosts : defaultPosts;
      const todayPost = posts.find(p => p.day === todayName);
      if (!todayPost) {
        console.log(`- ${platform}: aucun post programmé (${todayName}).`);
        continue;
      }
      const assets = buildAssets(todayPost, platform);
      console.log(`- ${platform}: ${todayPost.text.substring(0, 60).replace(/\n/g, ' ')}...`);
      if (platform === 'tiktok' && !assets.some(a => a.video)) {
        console.log(`  TikTok: aucune vidéo, publication non prévue.`);
      } else {
        for (const a of assets) {
          const url = a.image?.url || a.video?.url;
          console.log(`  média: ${url}`);
        }
      }
    }
    console.log('Dry-run terminé.');
    return;
  }

  const autoPublish = process.env.BUFFER_AUTOPUBLISH_ENABLED;
  if (autoPublish !== 'true') {
    throw new Error('Live Buffer publication is not enabled. Set BUFFER_AUTOPUBLISH=true to authorize.');
  }

  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (runAttempt && runAttempt !== '1') {
    throw new Error(`Live publication rejected on GitHub run attempt ${runAttempt}.`);
  }

  const token = process.env.BUFFER_ACCESS_TOKEN;
  const instagramChannelId = process.env.BUFFER_INSTAGRAM_CHANNEL_ID;
  const linkedinChannelId = process.env.BUFFER_LINKEDIN_CHANNEL_ID;
  const tiktokChannelId = process.env.BUFFER_TIKTOK_CHANNEL_ID;

  if (!token) {
    throw new Error('BUFFER_ACCESS_TOKEN is required for live mode.');
  }

  const configured = [
    { id: instagramChannelId, platform: 'instagram' },
    { id: linkedinChannelId, platform: 'linkedin' },
    { id: tiktokChannelId, platform: 'tiktok' }
  ].filter(c => c.id);

  if (configured.length === 0) {
    throw new Error('At least one BUFFER_*_CHANNEL_ID is required for live mode.');
  }

  const channels = await resolveChannels(token, configured, fetchImpl);
  const todayParisDate = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  const failures = [];
  let attempted = false;

  for (const { id: channelId, platform } of channels) {
    console.log(`\nPréparation du canal ${platform}`);

    const posts = platform === 'linkedin' ? linkedinPosts : defaultPosts;
    const todayPost = posts.find(p => p.day === todayName);

    if (!todayPost) {
      console.log(`Aucun post programmé pour ${platform} (${todayName}).`);
      continue;
    }

    const assets = buildAssets(todayPost, platform);

    if (platform === 'tiktok' && !assets.some(a => a.video)) {
      console.log('TikTok ignoré : aucune vidéo disponible pour ce post.');
      continue;
    }

    attempted = true;

    const isDuplicate = await findTodayDuplicate({
      token,
      channelId,
      platform,
      todayText: todayPost.text,
      todayParisDate,
      fetchImpl
    });

    if (isDuplicate) {
      console.log(`duplicate_detected=true platform=${platform}`);
      continue;
    }

    const metadata = getPlatformMetadata(platform, assets);

    try {
      const postId = await createBufferPost({
        token,
        text: todayPost.text,
        channelId,
        schedulingType: 'automatic',
        mode: 'shareNow',
        assets: assets.length > 0 ? assets : undefined,
        metadata,
        fetchImpl
      });
      console.log(`Post publié sur ${platform} (ID: ${postId})`);
    } catch (err) {
      console.error(`Échec publication ${platform} : ${err.classification || err.message}`);
      failures.push({ platform, classification: err.classification || 'unknown' });
    }
  }

  if (!attempted) {
    console.log('Aucune publication tentée aujourd\u2019hui.');
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} échec(s) de publication : ${failures.map(f => `${f.platform} (${f.classification})`).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('Tous les posts programmés ont été transmis à Buffer.');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { live: false };
  }
  if (args.includes('--dry-run')) {
    if (args.length > 1) {
      console.error('Unknown option combined with --dry-run.');
      process.exit(1);
    }
    return { live: false };
  }
  if (args.includes('--live')) {
    if (args.length > 1) {
      console.error('Unknown option combined with --live.');
      process.exit(1);
    }
    return { live: true };
  }
  console.error(`Unknown option: ${args[0]}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(path.join(process.cwd(), 'scripts', 'post-to-buffer.js'))) {
  const options = parseArgs(process.argv);
  publishTodayPost(options).catch(err => {
    console.error('Erreur inattendue :', err.message);
    process.exit(1);
  });
}
