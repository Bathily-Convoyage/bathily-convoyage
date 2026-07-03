import 'dotenv/config';
import fs from 'fs';
import path from 'path';

async function scheduleJuly2026Posts() {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const instagramChannelId = process.env.BUFFER_INSTAGRAM_CHANNEL_ID;

  if (!token) {
    console.error("❌ La variable d'environnement BUFFER_ACCESS_TOKEN est requise.");
    process.exit(1);
  }

  if (!instagramChannelId) {
    console.error("❌ La variable d'environnement BUFFER_INSTAGRAM_CHANNEL_ID est requise.");
    process.exit(1);
  }

  // Lire les posts
  const postsPath = path.join(process.cwd(), 'data', 'social-posts-juillet-2026.json');
  if (!fs.existsSync(postsPath)) {
    console.error("❌ Fichier social-posts-juillet-2026.json introuvable.");
    process.exit(1);
  }

  const allPosts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));

  // === FILTRER : 1 seul post par jour (Instagram uniquement) ===
  const seenDates = new Set();
  const dailyPosts = allPosts.filter(post => {
    if (post.platform !== 'instagram') return false;
    if (seenDates.has(post.date)) return false;
    seenDates.add(post.date);
    return true;
  });

  console.log(`📅 ${allPosts.length} posts au total → ${dailyPosts.length} posts retenus (1/jour, Instagram)\n`);

  // Charger les dates déjà publiées
  const publishedPath = path.join(process.cwd(), 'data', 'published-dates.json');
  let publishedDates = new Set();
  if (fs.existsSync(publishedPath)) {
    publishedDates = new Set(JSON.parse(fs.readFileSync(publishedPath, 'utf8')));
    console.log(`📋 ${publishedDates.size} dates déjà publiées (seront ignorées)\n`);
  }

  // Heure de publication : 12h00 (heure locale)
  const PUBLISH_HOUR = 12;
  const PUBLISH_MINUTE = 0;

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const newPublishedDates = [];

  for (const post of dailyPosts) {
    if (publishedDates.has(post.date)) {
      console.log(`⏭ ${post.date} déjà publié, on ignore`);
      skippedCount++;
      continue;
    }

    // Calculer la date/heure de planification
    const [year, month, day] = post.date.split('-').map(Number);
    const scheduledDate = new Date(year, month - 1, day, PUBLISH_HOUR, PUBLISH_MINUTE, 0);
    const now = new Date();

    // Si la date est déjà passée, on saute
    if (scheduledDate <= now) {
      console.log(`⏭ ${post.date} date déjà passée, on ignore`);
      skippedCount++;
      continue;
    }

    const scheduledAt = scheduledDate.toISOString();
    console.log(`📤 Planification: ${post.date} à ${PUBLISH_HOUR}h${String(PUBLISH_MINUTE).padStart(2, '0')} - "${post.text.substring(0, 50)}..."`);

    // Préparer les assets
    const assets = [];
    if (post.media) {
      assets.push({ image: { url: post.media } });
    }

    // Metadata Instagram (post classique)
    const metadata = {
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
        channelId: instagramChannelId,
        schedulingType: 'automatic',
        mode: 'customScheduled',
        dueAt: scheduledAt,
        metadata: metadata,
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
          console.log(`✅ Planifié pour le ${post.date} à ${PUBLISH_HOUR}h ! ID: ${result.post.id}`);
          successCount++;
          newPublishedDates.push(post.date);
          // Sauvegarder immédiatement
          const allDates = [...publishedDates, ...newPublishedDates];
          fs.writeFileSync(publishedPath, JSON.stringify([...allDates]));
        } else {
          console.error(`❌ Échec:`, result.message);
          errorCount++;
        }
      } else {
        console.error(`❌ Échec API:`, JSON.stringify(data).substring(0, 200));
        errorCount++;
      }
    } catch (err) {
      console.error(`❌ Erreur: ${err.message}`);
      errorCount++;
    }

    // Attendre 5s entre chaque post
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  console.log(`\n📊 Résumé: ${successCount} planifiés, ${errorCount} erreurs, ${skippedCount} ignorés`);
  if (newPublishedDates.length > 0) {
    console.log(`📅 Dates planifiées: ${newPublishedDates.join(', ')}`);
  }
}

scheduleJuly2026Posts();
