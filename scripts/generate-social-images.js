import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATES_PATH = path.join(__dirname, '..', 'social-media', 'templates.html');
const OUTPUT_DIR = path.join(__dirname, '..', 'images', 'social', 'generated');

async function generateSocialImages() {
  // Créer le dossier de sortie
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('🚀 Lancement du navigateur Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const fileUrl = 'file://' + TEMPLATES_PATH.replace(/\\/g, '/');

    console.log(`📄 Chargement des templates : ${fileUrl}`);
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });

    // Attendre le chargement des fonts
    await page.evaluateHandle('document.fonts.ready');
    await new Promise(resolve => setTimeout(resolve, 1000));

    const templates = await page.$$eval('.template', elements => {
      return elements.map(el => ({
        name: el.dataset.name,
        width: parseInt(el.dataset.width, 10),
        height: parseInt(el.dataset.height, 10)
      }));
    });

    console.log(`🎨 ${templates.length} templates trouvés\n`);

    for (const { name, width, height } of templates) {
      const outputPath = path.join(OUTPUT_DIR, `${name}.png`);
      const element = await page.$(`.template[data-name="${name}"]`);

      if (!element) {
        console.warn(`⚠️ Template non trouvé : ${name}`);
        continue;
      }

      await element.screenshot({
        path: outputPath,
        type: 'png',
        omitBackground: false
      });

      console.log(`✅ ${name}.png généré (${width}x${height})`);
    }

    console.log(`\n📁 Images sauvegardées dans : ${OUTPUT_DIR}`);
  } catch (err) {
    console.error('❌ Erreur lors de la génération :', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

generateSocialImages();
