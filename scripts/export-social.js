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
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  
  const htmlUrl = `file://${path.resolve(htmlPath)}`;
  await page.goto(htmlUrl, { waitUntil: 'networkidle0' });
  
  await page.screenshot({
    path: outputPath,
    clip: { x: 0, y: 0, width: 1080, height: 1080 },
    type: 'png'
  });
  
  await browser.close();
  
  console.log(`✓ PNG generated (1080x1080): ${outputPath}`);
}

async function main() {
  const assetsDir = path.join(__dirname, '..', 'social-media', 'assets');
  
  console.log('🚀 Starting social media assets generation...\n');
  
  const infographies = [
    { html: 'infographie-gps.html', name: 'infographie-gps.png' },
    { html: 'infographie-etat-lieux.html', name: 'infographie-etat-lieux.png' },
    { html: 'infographie-process.html', name: 'infographie-process.png' },
    { html: 'infographie-comparaison.html', name: 'infographie-comparaison.png' },
    { html: 'infographie-faq.html', name: 'infographie-faq.png' }
  ];
  
  const visuels = [
    { html: 'visuel-route.html', name: 'visuel-route.png' },
    { html: 'visuel-plateau.html', name: 'visuel-plateau.png' },
    { html: 'visuel-convoyeur.html', name: 'visuel-convoyeur.png' },
    { html: 'visuel-temoignage.html', name: 'visuel-temoignage.png' },
    { html: 'visuel-offre-juillet.html', name: 'visuel-offre-juillet.png' },
    { html: 'visuel-pack-starter.html', name: 'visuel-pack-starter.png' },
    { html: 'visuel-pack-serenite.html', name: 'visuel-pack-serenite.png' },
    { html: 'visuel-pack-excellence.html', name: 'visuel-pack-excellence.png' },
    { html: 'visuel-concession.html', name: 'visuel-concession.png' },
    { html: 'visuel-loueur.html', name: 'visuel-loueur.png' },
    { html: 'visuel-flotte.html', name: 'visuel-flotte.png' },
    { html: 'visuel-devis.html', name: 'visuel-devis.png' },
    { html: 'visuel-urgence.html', name: 'visuel-urgence.png' },
    { html: 'visuel-ete.html', name: 'visuel-ete.png' },
    { html: 'visuel-auto-moto.html', name: 'visuel-auto-moto.png' },
    { html: 'visuel-offre-fin.html', name: 'visuel-offre-fin.png' },
    { html: 'visuel-recap.html', name: 'visuel-recap.png' }
  ];
  
  for (const info of infographies) {
    const htmlPath = path.join(assetsDir, info.html);
    const pngPath = path.join(assetsDir, info.name);
    await generatePNG(htmlPath, pngPath);
  }
  
  for (const visuel of visuels) {
    const htmlPath = path.join(assetsDir, visuel.html);
    const pngPath = path.join(assetsDir, visuel.name);
    await generatePNG(htmlPath, pngPath);
  }
  
  console.log('\n✅ All social media assets generated successfully!');
  console.log('📁 Assets directory:', assetsDir);
}

main().catch(console.error);
