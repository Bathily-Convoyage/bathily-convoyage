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
    { html: 'visuel-offre-juillet.html', name: 'visuel-offre-juillet.png' }
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
