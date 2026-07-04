import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

ffmpeg.setFfmpegPath(ffmpegStatic);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_PATH = path.join(__dirname, '..', 'social-media', 'video-template.html');
const OUTPUT_DIR = path.join(__dirname, '..', 'videos', 'tiktok');

const VIDEO_DURATION_MS = 20000;
const VIDEO_SIZE = { width: 1080, height: 1920 };

async function generateTikTokVideo() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('🚀 Lancement de Playwright pour l\'enregistrement vidéo...');

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    viewport: VIDEO_SIZE,
    recordVideo: {
      dir: OUTPUT_DIR,
      size: VIDEO_SIZE
    }
  });

  const page = await context.newPage();
  const fileUrl = 'file://' + TEMPLATE_PATH.replace(/\\/g, '/');

  console.log(`📄 Chargement du template : ${fileUrl}`);
  await page.goto(fileUrl, { waitUntil: 'networkidle' });

  // Attendre le chargement des fonts et le début des animations
  await page.evaluateHandle('document.fonts.ready');
  await page.waitForTimeout(500);

  console.log(`🎥 Enregistrement de ${VIDEO_DURATION_MS / 1000}s de vidéo...`);
  await page.waitForTimeout(VIDEO_DURATION_MS);

  await context.close();
  await browser.close();

  // Playwright génère un nom aléatoire en .webm
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.webm'));
  if (files.length === 0) {
    console.warn('⚠️ Aucune vidéo trouvée');
    return;
  }

  const lastFile = files.sort().pop();
  const webmPath = path.join(OUTPUT_DIR, lastFile);
  const mp4Path = path.join(OUTPUT_DIR, 'bathily-convoyage-reel.mp4');

  console.log('🔄 Conversion en MP4...');
  await new Promise((resolve, reject) => {
    ffmpeg(webmPath)
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-crf 23',
        '-preset fast'
      ])
      .output(mp4Path)
      .on('end', () => {
        fs.unlinkSync(webmPath);
        console.log(`✅ Vidéo MP4 générée : ${mp4Path}`);
        resolve();
      })
      .on('error', err => {
        console.error('❌ Erreur de conversion :', err.message);
        reject(err);
      })
      .run();
  });
}

generateTikTokVideo().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
