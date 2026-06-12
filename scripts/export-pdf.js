import puppeteer from 'puppeteer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generatePDF(htmlPath, outputPath, options = {}) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Load HTML file
  const htmlUrl = `file://${path.resolve(htmlPath)}`;
  await page.goto(htmlUrl, { waitUntil: 'networkidle0' });
  
  // Generate PDF at 300dpi (scale 1.25)
  const pdfOptions = {
    path: outputPath,
    format: options.format || 'A4',
    printBackground: true,
    scale: 1.25, // 300dpi approximation
    margin: {
      top: '0mm',
      right: '0mm',
      bottom: '0mm',
      left: '0mm'
    }
  };
  
  await page.pdf(pdfOptions);
  await browser.close();
  
  console.log(`✓ PDF generated: ${outputPath}`);
}

async function generatePNG(htmlPath, outputPath, options = {}) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Load HTML file
  const htmlUrl = `file://${path.resolve(htmlPath)}`;
  await page.goto(htmlUrl, { waitUntil: 'networkidle0' });
  
  // Screenshot at high resolution
  const screenshotOptions = {
    path: outputPath,
    fullPage: true,
    type: 'png'
  };
  
  await page.screenshot(screenshotOptions);
  await browser.close();
  
  console.log(`✓ PNG generated: ${outputPath}`);
}

async function convertPDFToPNG(pdfPath, pngPath, quality = 80) {
  const pdfBuffer = fs.readFileSync(pdfPath);
  
  // Convert first page to PNG using sharp
  await sharp(pdfBuffer, { density: 300 })
    .png({ quality })
    .toFile(pngPath);
  
  console.log(`✓ PNG generated: ${pngPath}`);
}

async function convertPNGToWebP(pngPath, webpPath, quality = 80) {
  await sharp(pngPath)
    .webp({ quality })
    .toFile(webpPath);
  
  console.log(`✓ WebP generated: ${webpPath}`);
}

async function main() {
  const exportsDir = path.join(__dirname, '..', 'exports');
  const designDir = path.join(__dirname, '..', 'design');
  const imagesDir = path.join(__dirname, '..', 'images');
  
  // Ensure directories exist
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  
  console.log('🚀 Starting PDF generation...\n');
  
  // Generate brochure PDF
  const plaquetteHtml = path.join(designDir, 'plaquette.html');
  const plaquettePDF = path.join(exportsDir, 'plaquette-v2.pdf');
  const plaquettePNG = path.join(exportsDir, 'plaquette-v2.png');
  const plaquetteWebP = path.join(exportsDir, 'plaquette-v2.webp');
  
  await generatePDF(plaquetteHtml, plaquettePDF, { format: 'A4' });
  await generatePNG(plaquetteHtml, plaquettePNG);
  await convertPNGToWebP(plaquettePNG, plaquetteWebP, 80);
  
  // Copy to images directory
  try {
    if (fs.existsSync(plaquettePDF)) {
      fs.copyFileSync(plaquettePDF, path.join(imagesDir, 'plaquette-commerciale-v2.pdf'));
      console.log('✓ PDF copied to images');
    }
    if (fs.existsSync(plaquetteWebP)) {
      fs.copyFileSync(plaquetteWebP, path.join(imagesDir, 'plaquette-commerciale-v2.webp'));
      console.log('✓ WebP copied to images');
    }
  } catch (err) {
    console.log('⚠ Copy error (files in exports/):', err.message);
  }
  
  // Generate business card PDF
  const carteHtml = path.join(designDir, 'carte.html');
  const cartePDF = path.join(exportsDir, 'carte-v2.pdf');
  const cartePNG = path.join(exportsDir, 'carte-v2.png');
  const carteWebP = path.join(exportsDir, 'carte-v2.webp');
  
  await generatePDF(carteHtml, cartePDF, { format: 'A4' });
  await generatePNG(carteHtml, cartePNG);
  await convertPNGToWebP(cartePNG, carteWebP, 80);
  
  // Copy to images directory
  try {
    if (fs.existsSync(cartePDF)) {
      fs.copyFileSync(cartePDF, path.join(imagesDir, 'carte-de-visite-v2.pdf'));
      console.log('✓ Card PDF copied to images');
    }
    if (fs.existsSync(carteWebP)) {
      fs.copyFileSync(carteWebP, path.join(imagesDir, 'carte-de-visite-v2.webp'));
      console.log('✓ Card WebP copied to images');
    }
  } catch (err) {
    console.log('⚠ Card copy error (files in exports/):', err.message);
  }
  
  console.log('\n✅ All files generated successfully!');
  console.log('📁 Exports directory:', exportsDir);
  console.log('🖼️ Images directory:', imagesDir);
}

main().catch(console.error);
