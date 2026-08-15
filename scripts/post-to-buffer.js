import 'dotenv/config';
import fs from 'fs';
import path from 'path';

async function publishTodayPost() {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const instagramChannelId = process.env.BUFFER_INSTAGRAM_CHANNEL_ID;
  const linkedinChannelId = process.env.BUFFER_LINKEDIN_CHANNEL_ID;
  const tiktokChannelId = process.env.BUFFER_TIKTOK_CHANNEL_ID;

  const channels = [];
  if (instagramChannelId) channels.push({ id: instagramChannelId.trim(), platform: 'instagram' });
  if (linkedinChannelId) channels.push({ id: linkedinChannelId.trim(), platform: 'linkedin' });
  if (tiktokChannelId) channels.push({ id: tiktokChannelId.trim(), platform: 'tiktok' });

  if (!token || channels.length === 0) {
    console.error('Configuration manquante : BUFFER_ACCESS_TOKEN et au moins un BUFFER_*_CHANNEL_ID sont requis.');
    process.exit(1);
  }

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayName = days[new Date().getDay()];
  console.log(`Jour détecté : ${todayName}`);

  const defaultPostsPath = path.join(process.cwd(), 'data', 'social-posts.json');
  const linkedinPostsPath = path.join(process.cwd(), 'data', 'social-posts-linkedin.json');

  if (!fs.existsSync(defaultPostsPath)) {
    console.error('Fichier data/social-posts.json introuvable.');
    process.exit(1);
  }

  const defaultPosts = JSON.parse(fs.readFileSync(defaultPostsPath, 'utf8'));
  const linkedinPosts = fs.existsSync(linkedinPostsPath)
    ? JSON.parse(fs.readFileSync(linkedinPostsPath, 'utf8'))
    : defaultPosts;

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

    console.log(`Publication ${platform} : "${todayPost.text.substring(0, 50)}..."`);

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

    if (platform === 'tiktok' && !assets.some(a => a.video)) {
      console.log('TikTok ignoré : aucune vidéo disponible pour ce post.');
      continue;
    }

    attempted = true;

    const query = `
      mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          __typename
          ... on PostActionSuccess {
            post {
              id
            }
          }
          ... on MutationError {
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        text: todayPost.text,
        channelId: channelId,
        schedulingType: 'automatic',
        mode: 'shareNow',
        metadata: getPlatformMetadata(platform, assets),
        assets: assets.length > 0 ? assets : undefined
      }
    };

    try {
      const response = await fetch('https://api.buffer.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables })
      });

      const data = await response.json();

      if (response.ok && data?.data?.createPost) {
        const result = data.data.createPost;
        if (result.__typename === 'PostActionSuccess') {
          console.log(`Post publié sur ${platform} (ID: ${result.post.id})`);
        } else {
          console.error(`Buffer a refusé la publication sur ${platform} : ${result.message || 'unknown'}`);
          failures.push({ platform, status: 200, classification: 'buffer_graphql_error' });
        }
      } else {
        const status = response.status;
        console.error(`Échec API Buffer pour ${platform} : HTTP ${status}`);
        failures.push({ platform, status, classification: 'buffer_http_error' });
      }
    } catch (err) {
      console.error(`Erreur réseau pour ${platform} : ${err.name}`);
      failures.push({ platform, status: 'network', classification: 'network_error' });
    }
  }

  if (!attempted) {
    console.log('Aucune publication tentée aujourd\u2019hui.');
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} échec(s) de publication : ${failures.map(f => `${f.platform} (${f.classification})`).join(', ')}`);
    process.exit(1);
  }

  console.log('Tous les posts programmés ont été transmis à Buffer.');
}

function getPlatformMetadata(platform, assets) {
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

publishTodayPost().catch(err => {
  console.error('Erreur inattendue :', err.name);
  process.exit(1);
});
