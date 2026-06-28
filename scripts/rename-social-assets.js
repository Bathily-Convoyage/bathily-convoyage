import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const assetsDir = path.join(__dirname, '..', 'social-media', 'assets');

const mappings = [
  // Plaquettes
  { from: 'plaquette-v2.png', to: 'Plaquette-v2.png' },
  { from: 'plaquette-pro-v1.png', to: 'Plaquette-pro-v1.png' },
  
  // Infographies
  { from: 'infographie-gps.png', to: 'Infographie-GPS.png' },
  { from: 'infographie-etat-lieux.png', to: 'Photo-etat-lieux.png' },
  { from: 'infographie-process.png', to: 'Infographie-process.png' },
  { from: 'infographie-comparaison.png', to: 'Infographie-comparaison.png' },
  { from: 'infographie-faq.png', to: 'Infographie-FAQ.png' },
  
  // Packs
  { from: 'visuel-pack-starter.png', to: 'Plaquette-pack-starter.png' },
  { from: 'visuel-pack-serenite.png', to: 'Plaquette-pack-serenite.png' },
  { from: 'visuel-pack-excellence.png', to: 'Plaquette-pack-excellence.png' },
  
  // B2B
  { from: 'visuel-concession.png', to: 'Plaquette-concession.png' },
  { from: 'visuel-loueur.png', to: 'Plaquette-loueur.png' },
  { from: 'visuel-flotte.png', to: 'Plaquette-flotte.png' },
  
  // Services
  { from: 'visuel-route.png', to: 'Photo-route.png' },
  { from: 'visuel-plateau.png', to: 'Photo-plateau.png' },
  { from: 'visuel-convoyeur.png', to: 'Photo-convoyeur.png' },
  { from: 'visuel-temoignage.png', to: 'Photo-temoignage.png' },
  { from: 'visuel-devis.png', to: 'Capture-devis.png' },
  { from: 'visuel-urgence.png', to: 'Photo-urgence.png' },
  { from: 'visuel-ete.png', to: 'Photo-ete.png' },
  { from: 'visuel-auto-moto.png', to: 'Photo-auto-moto.png' },
  
  // Offres
  { from: 'visuel-offre-juillet.png', to: 'Offre-juillet.png' },
  { from: 'visuel-offre-fin.png', to: 'Offre-fin.png' },
  { from: 'visuel-recap.png', to: 'Recap-juillet.png' }
];

function main() {
  console.log('🔄 Renaming social media assets to match CSV names...\n');
  
  for (const mapping of mappings) {
    const fromPath = path.join(assetsDir, mapping.from);
    const toPath = path.join(assetsDir, mapping.to);
    
    if (fs.existsSync(fromPath)) {
      fs.copyFileSync(fromPath, toPath);
      console.log(`✓ Copied ${mapping.from} → ${mapping.to}`);
    } else {
      console.log(`⚠ Source not found: ${mapping.from}`);
    }
  }
  
  console.log('\n✅ Asset renaming completed!');
  console.log('📁 Assets directory:', assetsDir);
}

main().catch(console.error);
