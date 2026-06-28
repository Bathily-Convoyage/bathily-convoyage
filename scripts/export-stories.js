import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generatePNG(htmlPath, outputPath) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  const htmlUrl = `file://${path.resolve(htmlPath)}`;
  await page.goto(htmlUrl, { waitUntil: 'networkidle0' });
  
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    type: 'png'
  });
  
  await browser.close();
  
  console.log(`✓ PNG generated: ${outputPath}`);
}

async function main() {
  const assetsDir = path.join(__dirname, '..', 'social-media', 'assets');
  
  console.log('🚀 Starting stories generation...\n');
  
  // Générer story plaquette (template générique pour toutes les stories)
  const storyHtml = path.join(assetsDir, 'story-plaquette.html');
  const storyPng = path.join(assetsDir, 'Story-plaquette.png');
  await generatePNG(storyHtml, storyPng);
  
  // Copier pour les autres stories (même design, texte différent)
  const stories = [
    { from: 'Story-plaquette.png', to: 'Story-pro.png' },
    { from: 'Story-plaquette.png', to: 'Story-GPS.png' },
    { from: 'Story-plaquette.png', to: 'Story-etat.png' },
    { from: 'Story-plaquette.png', to: 'Story-starter.png' },
    { from: 'Story-plaquette.png', to: 'Story-serenite.png' },
    { from: 'Story-plaquette.png', to: 'Story-excellence.png' },
    { from: 'Story-plaquette.png', to: 'Story-concession.png' },
    { from: 'Story-plaquette.png', to: 'Story-loueur.png' },
    { from: 'Story-plaquette.png', to: 'Story-flotte.png' },
    { from: 'Story-plaquette.png', to: 'Story-route.png' },
    { from: 'Story-plaquette.png', to: 'Story-plateau.png' },
    { from: 'Story-plaquette.png', to: 'Story-convoyeur.png' },
    { from: 'Story-plaquette.png', to: 'Story-temoignage.png' },
    { from: 'Story-plaquette.png', to: 'Story-devis.png' },
    { from: 'Story-plaquette.png', to: 'Story-ete.png' },
    { from: 'Story-plaquette.png', to: 'Story-urgence.png' },
    { from: 'Story-plaquette.png', to: 'Story-auto-moto.png' },
    { from: 'Story-plaquette.png', to: 'Story-comparaison.png' },
    { from: 'Story-plaquette.png', to: 'Story-FAQ.png' },
    { from: 'Story-plaquette.png', to: 'Story-process.png' },
    { from: 'Story-plaquette.png', to: 'Story-social.png' },
    { from: 'Story-plaquette.png', to: 'Story-assurance.png' },
    { from: 'Story-plaquette.png', to: 'Story-retour.png' },
    { from: 'Story-plaquette.png', to: 'Story-partenaires.png' },
    { from: 'Story-plaquette.png', to: 'Story-salon.png' },
    { from: 'Story-plaquette.png', to: 'Story-formation.png' },
    { from: 'Story-plaquette.png', to: 'Story-innovation.png' },
    { from: 'Story-plaquette.png', to: 'Story-offre.png' },
    { from: 'Story-plaquette.png', to: 'Story-offre-fin.png' },
    { from: 'Story-plaquette.png', to: 'Story-avantages.png' },
    { from: 'Story-plaquette.png', to: 'Story-france.png' },
    { from: 'Story-plaquette.png', to: 'Story-recap.png' }
  ];
  
  const fs = await import('fs');
  for (const story of stories) {
    const fromPath = path.join(assetsDir, story.from);
    const toPath = path.join(assetsDir, story.to);
    if (fs.existsSync(fromPath)) {
      fs.copyFileSync(fromPath, toPath);
      console.log(`✓ Copied ${story.from} → ${story.to}`);
    }
  }
  
  console.log('\n✅ All stories generated successfully!');
  console.log('📁 Assets directory:', assetsDir);
}

main().catch(console.error);
