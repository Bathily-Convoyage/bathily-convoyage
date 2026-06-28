import fs from 'fs';
import path from 'path';

async function scheduleJuly2026Posts() {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const profileIds = process.env.BUFFER_PROFILE_IDS ? process.env.BUFFER_PROFILE_IDS.split(',') : [];

  if (!token || profileIds.length === 0) {
    console.error("❌ Les variables d'environnement BUFFER_ACCESS_TOKEN et BUFFER_PROFILE_IDS sont requises.");
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

  // Mapper les plateformes aux channel IDs
  const platformChannelMap = {};
  if (profileIds.length >= 3) {
    platformChannelMap['instagram'] = profileIds[0];
    platformChannelMap['instagram-story'] = profileIds[0];
    platformChannelMap['tiktok'] = profileIds[1];
    platformChannelMap['linkedin'] = profileIds[2];
  } else {
    console.error("❌ Il faut au moins 3 profile IDs (Instagram, TikTok, LinkedIn)");
    process.exit(1);
  }

  console.log('Mapping plateformes → Channel IDs:');
  console.log('  Instagram →', platformChannelMap['instagram']);
  console.log('  TikTok →', platformChannelMap['tiktok']);
  console.log('  LinkedIn →', platformChannelMap['linkedin']);
  console.log();

  let successCount = 0;
  let errorCount = 0;

  for (const post of posts) {
    const channelId = platformChannelMap[post.platform];
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

    // Déterminer le type de post Instagram
    const isStory = post.platform === 'instagram-story';
    const metadata = isStory ? {
      instagram: {
        type: 'story',
        shouldShareToFeed: false
      }
    } : {
      instagram: {
        type: 'post',
        shouldShareToFeed: true
      }
    };

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
        schedulingType: 'scheduled',
        scheduledAt: `${post.date}T09:00:00Z`, // 9h UTC par défaut
        mode: 'shareNow',
        metadata: metadata,
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
          console.log(`✅ Post planifié avec succès ! ID: ${result.post.id}`);
          successCount++;
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

    // Attendre 500ms entre chaque post pour éviter rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\n📊 Résumé: ${successCount} succès, ${errorCount} erreurs sur ${posts.length} posts`);
}

scheduleJuly2026Posts();
