import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration Buffer API v1
const BUFFER_ACCESS_TOKEN = 'pu4Xem4CjrtuPt0jeQTlGuV7TAyRYwZoA7PqHwf40mf';
const BUFFER_API_URL = 'https://api.bufferapp.com/1';

// Lire le CSV
const csvPath = path.join(__dirname, '..', 'social-media', 'calendrier-juillet-2026.csv');
const csvContent = fs.readFileSync(csvPath, 'utf-8');

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header.trim()] = values[index]?.trim() || '';
    });
    if (row.Date && row.Plateforme) {
      data.push(row);
    }
  }
  
  return data;
}

async function getProfiles() {
  try {
    const response = await fetch(`${BUFFER_API_URL}/profiles.json`, {
      headers: {
        'Authorization': `Bearer ${BUFFER_ACCESS_TOKEN}`
      }
    });
    
    if (response.ok) {
      const profiles = await response.json();
      return profiles || [];
    } else {
      const error = await response.text();
      console.log(`✗ Error fetching profiles: ${error}`);
    }
  } catch (error) {
    console.log(`✗ Request failed: ${error.message}`);
  }
  return [];
}

async function createPost(post, profileId) {
  // Construire le payload pour Buffer v1
  const payload = {
    text: `${post.Légence}\n\n${post.Hashtags}`,
    profile_ids: [profileId],
    scheduled_at: `${post.Date}T09:00:00Z`, // 9h UTC par défaut
    media: post.Visuel ? {
      type: 'image',
      url: post.Visuel // Buffer v1 nécessite une URL publique
    } : null
  };
  
  try {
    const response = await fetch(`${BUFFER_API_URL}/updates/create.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BUFFER_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(`✓ Post created: ${post.Date} - ${post.Plateforme} - ${post.Contenu}`);
      return result;
    } else {
      const error = await response.text();
      console.log(`✗ Error creating post: ${error}`);
    }
  } catch (error) {
    console.log(`✗ Request failed: ${error.message}`);
  }
}

async function main() {
  console.log('🚀 Starting Buffer v1 import...\n');
  
  // Récupérer les profiles disponibles
  const profiles = await getProfiles();
  console.log(`Found ${profiles.length} profiles:\n`);
  profiles.forEach(p => {
    console.log(`  - ${p.service} (${p.id}): ${p.formatted_username || 'No name'}`);
  });
  
  // Mapper les plateformes du CSV aux profiles
  const platformMap = {};
  profiles.forEach(p => {
    const service = p.service.toLowerCase();
    if (!platformMap[service]) {
      platformMap[service] = p.id;
    }
  });
  
  console.log('\nPlatform mapping:');
  console.log('  Instagram →', platformMap.instagram || 'Not found');
  console.log('  TikTok →', platformMap.tiktok || 'Not found');
  console.log('  LinkedIn →', platformMap.linkedin || 'Not found');
  
  const posts = parseCSV(csvContent);
  console.log(`\nFound ${posts.length} posts to import\n`);
  
  // Importer les 5 premiers posts pour tester
  const testPosts = posts.slice(0, 5);
  console.log('Testing with first 5 posts...\n');
  
  for (const post of testPosts) {
    const platform = post.Plateforme.toLowerCase();
    const profileId = platformMap[platform];
    
    if (!profileId) {
      console.log(`⚠ Profile not found for ${post.Plateforme}`);
      continue;
    }
    
    await createPost(post, profileId);
    // Attendre 1 seconde entre chaque post pour éviter rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n✅ Test import completed!');
  console.log('Note: Buffer v1 is deprecated and may have limitations.');
  console.log('Media files need to be uploaded to a public URL for Buffer to access them.');
}

main().catch(console.error);
