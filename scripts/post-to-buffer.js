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
    console.error("❌ Les variables d'environnement BUFFER_ACCESS_TOKEN et au moins un BUFFER_*_CHANNEL_ID sont requises.");
    process.exit(1);
  }

  // Obtenir le jour actuel en anglais (ex: "Monday", "Tuesday")
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayName = days[new Date().getDay()];
  console.log(`📅 Jour détecté : ${todayName}`);

  // Charger les posts selon la plateforme
  const defaultPostsPath = path.join(process.cwd(), 'data', 'social-posts.json');
  const linkedinPostsPath = path.join(process.cwd(), 'data', 'social-posts-linkedin.json');

  if (!fs.existsSync(defaultPostsPath)) {
    console.error("❌ Fichier social-posts.json introuvable.");
    process.exit(1);
  }

  const defaultPosts = JSON.parse(fs.readFileSync(defaultPostsPath, 'utf8'));
  const linkedinPosts = fs.existsSync(linkedinPostsPath)
    ? JSON.parse(fs.readFileSync(linkedinPostsPath, 'utf8'))
    : defaultPosts;

  // Pour chaque canal, envoyer le post avec la bonne configuration plateforme
  for (const { id: channelId, platform } of channels) {
    console.log(`📤 Envoi vers le canal ${platform} : ${channelId}`);

    // Sélectionner le bon fichier de posts selon la plateforme
    const posts = platform === 'linkedin' ? linkedinPosts : defaultPosts;
    const todayPost = posts.find(p => p.day === todayName);

    if (!todayPost) {
      console.log(`ℹ️ Aucun post programmé pour ${platform} (${todayName}).`);
      continue;
    }

    console.log(`🚀 Envoi du post ${platform} : "${todayPost.text.substring(0, 50)}..."`);

    // Préparer les variables GraphQL (supporte image, vidéo, carrousel)
    const assets = [];
    if (todayPost.media) {
      const mediaList = Array.isArray(todayPost.media) ? todayPost.media : [todayPost.media];
      for (const item of mediaList) {
        if (typeof item === 'string') {
          const isVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(item);
          assets.push(isVideo ? { video: { url: item } } : { image: { url: item } });
        } else if (item && item.url) {
          const isVideo = item.type === 'video' || /\.(mp4|mov|webm|mkv|avi)$/i.test(item.url);
          assets.push(isVideo ? { video: { url: item.url } } : { image: { url: item.url } });
        }
      }
    }

    // TikTok nécessite obligatoirement une vidéo
    if (platform === 'tiktok' && !assets.some(a => a.video)) {
      console.log(`⏭ TikTok ignoré : aucune vidéo disponible pour ce post`);
      continue;
    }

    const metadata = getPlatformMetadata(platform, assets);

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
        metadata,
        assets: assets.length > 0 ? assets : undefined
      }
    };

    try {
      const response = await fetch('https://api.buffer.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables })
      });

      const data = await response.json();

      if (response.ok && data.data && data.data.createPost) {
        const result = data.data.createPost;
        if (result.__typename === 'PostActionSuccess') {
          console.log(`✅ Post publié avec succès sur ${platform} (${channelId}) ! ID: ${result.post.id}`);
        } else {
          console.error(`❌ Échec de la publication sur ${platform} (${channelId}) :`, result.message);
        }
      } else {
        console.error(`❌ Échec API GraphQL pour ${platform} (${channelId}) :`, data);
      }
    } catch (err) {
      console.error(`❌ Erreur réseau pour ${platform} (${channelId}) :`, err.message);
    }
  }
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

publishTodayPost();
