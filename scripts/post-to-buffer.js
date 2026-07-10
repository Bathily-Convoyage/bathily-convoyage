import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

// Fonction pour générer l'image avec Puppeteer
async function generateBrandedImage(rawImageUrl, textContent, dayName) {
  console.log('🎨 Génération du visuel brandé en cours...');
  
  let title = textContent.split('.')[0] + '.';
  if (title.length > 80) title = title.substring(0, 80) + '...';

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080 });

  const templatePath = path.join(process.cwd(), 'social-media', 'template-auto.html');
  const templateUrl = `file://${templatePath.replace(/\\/g, '/')}`;

  await page.goto(templateUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  await page.evaluate((url, t) => {
    setContent(url, t);
  }, rawImageUrl, title);

  await new Promise(r => setTimeout(r, 500));

  // On sauvegarde l'image générée avec le nom du jour
  const imageName = `post-${dayName.toLowerCase()}.png`;
  const outputPath = path.join(process.cwd(), 'social-media', imageName);
  await page.screenshot({ path: outputPath, type: 'png' });
  await browser.close();

  console.log('✅ Visuel généré localement : ' + imageName);
  
  // On pousse l'image sur GitHub pour la rendre accessible par Buffer publiquement
  try {
    console.log('☁️ Upload du visuel sur GitHub...');
    execSync(`git add social-media/${imageName}`);
    execSync(`git commit -m "auto: ajout du visuel généré pour ${dayName}"`);
    execSync('git push origin main');
    console.log('✅ Visuel uploadé sur GitHub');
  } catch (e) {
    console.log('ℹ️ Le visuel est déjà à jour sur GitHub ou erreur mineure :', e.message);
  }

  // URL publique raw de GitHub (Buffer la lira sans problème)
  return `https://raw.githubusercontent.com/Bathily-Convoyage/bathily-convoyage/main/social-media/${imageName}`;
}

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

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayName = days[new Date().getDay()];
  console.log(`📅 Jour détecté : ${todayName}`);

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

  // On génère l'image une seule fois si on l'utilise pour plusieurs plateformes
  let generatedImageUrl = null;

  for (const { id: channelId, platform } of channels) {
    console.log(`\n📤 Envoi vers le canal ${platform} : ${channelId}`);

    const posts = platform === 'linkedin' ? linkedinPosts : defaultPosts;
    const todayPost = posts.find(p => p.day === todayName);

    if (!todayPost) {
      console.log(`ℹ️ Aucun post programmé pour ${platform} (${todayName}).`);
      continue;
    }

    console.log(`🚀 Préparation du post ${platform} : "${todayPost.text.substring(0, 50)}..."`);

    const assets = [];
    if (todayPost.media) {
      const mediaList = Array.isArray(todayPost.media) ? todayPost.media : [todayPost.media];
      
      for (const item of mediaList) {
        let urlToUse = typeof item === 'string' ? item : item.url;
        const isVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(urlToUse);
        
        if (!isVideo && !generatedImageUrl) {
          // Générer l'image brandée
          generatedImageUrl = await generateBrandedImage(urlToUse, todayPost.text, todayName);
        }

        // Si l'image a été générée avec succès, on remplace l'URL brute par l'URL de l'image générée
        if (!isVideo && generatedImageUrl) {
          urlToUse = generatedImageUrl;
        }

        assets.push(isVideo ? { video: { url: urlToUse } } : { image: { url: urlToUse } });
      }
    }

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
        console.error(`❌ Échec API GraphQL pour ${platform} (${channelId}) :`, JSON.stringify(data));
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

publishTodayPost().catch(console.error);
