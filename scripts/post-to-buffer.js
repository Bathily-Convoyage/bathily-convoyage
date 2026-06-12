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

  console.log(`🚀 Envoi du post vers Buffer : "${todayPost.text.substring(0, 50)}..."`);

  // Préparer la requête vers l'API Buffer
  // Endpoint : https://api.bufferapp.com/1/updates/create.json
  const params = new URLSearchParams();
  profileIds.forEach(id => params.append('profile_ids[]', id));
  params.append('text', todayPost.text);
  params.append('shorten', 'false'); // Empêche Buffer d'altérer vos liens bathily-convoyage.fr
  params.append('now', 'true'); // Publie immédiatement (ou false pour ajouter à la file d'attente Buffer)
  
  if (todayPost.media) {
    params.append('media[link]', todayPost.media);
    params.append('media[picture]', todayPost.media);
  }

  try {
    const response = await fetch(`https://api.bufferapp.com/1/updates/create.json?access_token=${token}`, {
      method: 'POST',
      body: params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const data = await response.json();

    if (response.ok) {
      console.log('✅ Post publié avec succès sur Buffer !', data);
    } else {
      console.error('❌ Échec de la publication Buffer :', data);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Erreur de requête vers Buffer :', err.message);
    process.exit(1);
  }
}

publishTodayPost();
