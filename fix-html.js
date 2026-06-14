const fs = require('fs');
const path = require('path');

const files = [
  'convoyage-bordeaux.html',
  'convoyage-lyon.html',
  'convoyage-marseille.html',
  'convoyage-montpellier.html',
  'convoyage-moto-voiture-france.html',
  'convoyage-moto-voiture-paris.html',
  'convoyage-toulouse.html',
  'convoyage-vehicule-lille.html',
  'convoyage-vehicule-nantes.html',
  'convoyage-vehicule-nice.html',
  'convoyage-vehicule-rennes.html',
  'convoyage-vehicule-strasbourg.html'
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) {
    console.log(`Fichier non trouvé : ${file}`);
    return;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  
  // 1. Remplacement de la ligne cassée du badge GPS avec le literal backtick+n et l'émoji corrompu
  // On remplace par un vrai saut de ligne et un émoji 📍 propre
  const originalBadgeRegex = /<\/h1>`n\s*<div class="badge-trust"[^>]*>ðŸ“\s*Suivi GPS en temps reel<\/div>/g;
  content = content.replace(originalBadgeRegex, '</h1>\n          <div class="badge-trust" style="margin-top: 10px; margin-bottom: 20px;">📍 Suivi GPS en temps réel</div>');
  
  // Remplacement générique du backtick+n restant au cas où
  content = content.replace(/<\/h1>`n/g, '</h1>\n');
  
  // 2. Remplacement des émojis corrompus par l'encodage
  content = content.replace(/ðŸš—\s*Auto/gi, '🚗 Auto');
  content = content.replace(/ðŸ\s*Moto/gi, '🏍️ Moto');
  content = content.replace(/ðŸ“\s*Suivi/gi, '📍 Suivi');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✅ Corrigé : ${file}`);
});

console.log('🎉 Tous les fichiers HTML ont été corrigés !');
