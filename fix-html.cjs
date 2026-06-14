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
  
  // 1. Corriger les sauts de ligne PowerShell invalides (`n)
  content = content.replace(/<\/h1>`n/g, '</h1>\n');
  
  // 2. Corriger la ligne du badge GPS (on matche tout le contenu de la div badge-trust qui se termine par GPS en temps reel)
  // Cela supprime tous les caractères de contrôle invisibles (comme le code 141 / 0x8D)
  content = content.replace(/<div class="badge-trust"[^>]*>([\s\S]*?)Suivi GPS en temps (reel|réel)<\/div>/g, 
    '<div class="badge-trust" style="margin-top: 10px; margin-bottom: 20px;">📍 Suivi GPS en temps réel</div>');
  
  // 3. Corriger les émojis des boutons d'onglets (Auto / Moto) sans se soucier des caractères corrompus
  content = content.replace(/data-value="Automobile"([^>]*)>([\s\S]*?)Auto<\/button>/gi, 
    'data-value="Automobile"$1>🚗 Auto</button>');
  
  content = content.replace(/data-value="Moto"([^>]*)>([\s\S]*?)Moto<\/button>/gi, 
    'data-value="Moto"$1>🏍️ Moto</button>');

  // 4. Nettoyage générique des résidus d'émojis corrompus
  content = content.replace(/ðŸ“\s*Suivi/gi, '📍 Suivi');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✅ Corrigé : ${file}`);
});

console.log('🎉 Tous les fichiers HTML ont été corrigés avec la méthode robuste !');
