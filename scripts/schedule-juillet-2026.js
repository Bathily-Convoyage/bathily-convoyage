import fs from 'fs';
import path from 'path';

async function scheduleJuly2026Posts() {
  const token = 'pu4Xem4CjrtuPt0jeQTlGuV7TAyRYwZoA7PqHwf40mf';
  // Channel IDs identifiés via les erreurs API
  // 6a36abc838b5579345b7f883 = LinkedIn
  // 6a419f085ab6d2f10681d3ac = TikTok
  // 6a2bd39638b5579345898778 = Instagram
  const profileIds = {
    instagram: '6a2bd39638b5579345898778',
    'instagram-story': '6a2bd39638b5579345898778',
    tiktok: '6a419f085ab6d2f10681d3ac',
    linkedin: '6a36abc838b5579345b7f883'
  };

  if (!token) {
    console.error("❌ La clé API Buffer est requise.");
    process.exit(1);
  }

  // Lire les posts juillet 2026
  const postsPath = path.join(process.cwd(), 'data', 'social-posts-juillet-2026.json');
  if (!fs.existsSync(postsPath)) {
    console.error("❌ Fichier social-posts-juillet-2026.json introuvable.");
    process.exit(1);
  }

  const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
  console.log(`📅 ${posts.length} posts à planifier pour juillet 2026\n`);

  // Charger les posts déjà publiés pour éviter les doublons
  const publishedPath = path.join(process.cwd(), 'data', 'published-posts.json');
  let publishedIds = new Set();
  if (fs.existsSync(publishedPath)) {
    publishedIds = new Set(JSON.parse(fs.readFileSync(publishedPath, 'utf8')));
    console.log(`📋 ${publishedIds.size} posts déjà publiés (seront ignorés)\n`);
  }
  const newPublishedIds = [];

  const postsToPublish = posts.filter((_, i) => !publishedIds.has(i));
  console.log(`🚀 ${postsToPublish.length} posts restants à planifier\n`);

  console.log('Mapping plateformes → Channel IDs:');
  console.log('  Instagram →', profileIds['instagram']);
  console.log('  TikTok →', profileIds['tiktok']);
  console.log('  LinkedIn →', profileIds['linkedin']);
  console.log();

  let successCount = 0;
  let errorCount = 0;

  for (let idx = 0; idx < posts.length; idx++) {
    if (publishedIds.has(idx)) continue;
    const post = posts[idx];
    const channelId = profileIds[post.platform];
    if (!channelId) {
      console.log(`⚠ Platforme non reconnue: ${post.platform}`);
      errorCount++;
      continue;
    }

    console.log(`📤 Planification: ${post.date} - ${post.platform} - "${post.text.substring(0, 40)}..."`);

    // Préparer les assets
    const assets = [];
    if (post.media) {
      assets.push({ image: { url: post.media } });
    }

    // Déterminer le type de post selon la plateforme
    let metadata = {};
    if (post.platform === 'instagram' || post.platform === 'instagram-story') {
      const isStory = post.platform === 'instagram-story';
      metadata = {
        instagram: {
          type: isStory ? 'story' : 'post',
          shouldShareToFeed: !isStory
        }
      };
    }
    // TikTok et LinkedIn: pas de metadata (envoyer objet vide provoque des erreurs)

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
        text: post.text,
        channelId: channelId,
        schedulingType: 'automatic',
        mode: 'shareNow',
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        assets: assets.length > 0 ? assets : undefined
      }
    };

    try {
      let retries = 3;
      let data = null;
      let response = null;

      while (retries > 0) {
        response = await fetch('https://api.buffer.com', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ query, variables })
        });

        data = await response.json();

        // Vérifier si rate limited
        const isRateLimited = data.errors && data.errors.some(e => e.message && e.message.includes('Too many requests'));

        if (!isRateLimited) break;

        retries--;
        if (retries > 0) {
          console.log(`⏳ Rate limited, retry dans 30s... (${retries} essais restants)`);
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
      }

      if (response.ok && data.data && data.data.createPost) {
        const result = data.data.createPost;
        if (result.__typename === 'PostActionSuccess') {
          console.log(`✅ Post planifié avec succès ! ID: ${result.post.id}`);
          successCount++;
          newPublishedIds.push(idx);
          // Sauvegarder immédiatement
          const allPublished = [...publishedIds, ...newPublishedIds];
          fs.writeFileSync(publishedPath, JSON.stringify([...allPublished]));
        } else {
          console.error(`❌ Échec de la planification:`, result.message);
          errorCount++;
        }
      } else {
        console.error(`❌ Échec de la requête API:`, data);
        errorCount++;
      }
    } catch (err) {
      console.error(`❌ Erreur de requête:`, err.message);
      errorCount++;
    }

    // Attendre 3s entre chaque post pour éviter rate limiting
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log(`\n📊 Résumé: ${successCount} succès, ${errorCount} erreurs sur ${posts.length} posts`);
}

scheduleJuly2026Posts();
