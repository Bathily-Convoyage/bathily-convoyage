const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const htmlFiles = fs.readdirSync(rootDir).filter(f => f.endsWith('.html'));

let phoneRegex1 = /0[1-9](\s|\.)?\d{2}(\s|\.)?\d{2}(\s|\.)?\d{2}(\s|\.)?\d{2}/g;
// Replace phone numbers specifically inside tel: and text
const newPhone = '07 58 36 22 49';
const newPhoneLink = '0758362249';

htmlFiles.forEach(file => {
  let content = fs.readFileSync(path.join(rootDir, file), 'utf8');
  let changed = false;

  // Fix header z-index
  if (file === 'index.html' || file.startsWith('convoyage-')) {
    if (content.includes('z-index: 100;')) {
      content = content.replace(/header\s*\{[^}]*z-index:\s*100;/g, match => match.replace('100', '9999'));
      changed = true;
    }
  }

  // Make mini cards clickable in index.html and SEO pages
  if (content.includes('class="pack-card"')) {
    // We add onclick to pack-card divs
    content = content.replace(/<div class="pack-card">/g, '<div class="pack-card" onclick="window.location.href=\'devis.html\'" style="cursor:pointer">');
    changed = true;
  }

  // Find existing tel: links to see what the old number is, then replace
  content = content.replace(/href="tel:[^"]+"/g, `href="tel:${newPhoneLink}"`);
  
  // Try to find the visible phone number. Let's look for "Nous appeler" or something.
  content = content.replace(/>0[1-9][0-9\s\.]+</g, `>${newPhone}<`);
  
  // Specific known dummy numbers
  content = content.replace(/06 12 34 56 78/g, newPhone);

  if (changed) {
    fs.writeFileSync(path.join(rootDir, file), content, 'utf8');
    console.log(`Updated ${file}`);
  }
});
