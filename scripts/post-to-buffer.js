import 'dotenv/config';
import fs from 'fs';
import path from 'path';

async function publishTodayPost() {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const profileIds = process.env.BUFFER_PROFILE_IDS ? process.env.BUFFER_PROFILE_IDS.split(',') : [];

  if (!token || profileIds.length === 0) {
    console.error("❌ Les variables d'environnement BUFFER_ACCESS_TOKEN et BUFFER_PROFILE_IDS sont requises.");
    process.exit(1);
  }

  // Obtenir le jour actuel en anglais (ex: "Monday", "Tuesday")
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayName = days[new Date().getDay()];
  console.log(`📅 Jour détecté : ${todayName}`);

  // Lire les posts
  const postsPath = path.join(process.cwd(), 'data', 'social-posts.json');
  if (!fs.existsSync(postsPath)) {
    console.error("❌ Fichier social-posts.json introuvable.");
    process.exit(1);
  }

  const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
  const todayPost = posts.find(p => p.day === todayName);

  if (!todayPost) {
    console.log(`ℹ️ Aucun post programmé pour aujourd'hui (${todayName}).`);
    return;
  }

  console.log(`🚀 Envoi du post vers Buffer (GraphQL) : "${todayPost.text.substring(0, 50)}..."`);

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

  // Pour chaque profil, nous faisons une requête d'insertion
  for (const channelId of profileIds) {
    console.log(`📤 Envoi vers le canal : ${channelId}`);
    
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
        metadata: {
          instagram: {
            type: 'post',
            shouldShareToFeed: true
          }
        },
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
          console.log(`✅ Post publié avec succès sur le canal ${channelId} ! ID: ${result.post.id}`);
        } else {
          console.error(`❌ Échec de la publication sur le canal ${channelId} :`, result.message);
          process.exit(1);
        }
      } else {
        console.error(`❌ Échec de la requête API GraphQL pour le canal ${channelId} :`, data);
        process.exit(1);
      }
    } catch (err) {
      console.error(`❌ Erreur de requête vers Buffer pour le canal ${channelId} :`, err.message);
      process.exit(1);
    }
  }
}

publishTodayPost();
