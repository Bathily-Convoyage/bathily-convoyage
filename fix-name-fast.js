const fs = require('fs');
const path = require('path');

const files = [
  'AUDIT-AUTO-MOTO.md',
  'AUDIT-CHARTE.md',
  'AUDIT-UX-CONCURRENTS.md',
  'bon-de-mission.html',
  'charte-graphique-complete.html',
  'charte_graphique.md',
  'contact.html',
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
  'convoyage-vehicule-strasbourg.html',
  'reset-password.html',
  'mentions-legales.html',
  'cgv.html',
  'index.html',
  'tarifs.html',
  'services.html',
  'devis.html',
  'devenir-convoyeur.html',
  'dashboard-client.html',
  'dashboard-convoyeur.html',
  'dashboard-admin.html',
  'apropos.html',
  'FAQ.html',
  'netlify/functions/admin-create-user.js',
  'netlify/functions/create-checkout-session.js',
  'netlify/functions/send-email.js',
  'netlify/functions/stripe-webhook.js',
  'netlify/functions/lookup-vehicle.js'
];

let modifiedFiles = 0;

files.forEach(f => {
  const filePath = path.join(__dirname, f);
  if (fs.existsSync(filePath)) {
    const originalContent = fs.readFileSync(filePath, 'utf8');
    const newContent = originalContent.replace(/Bathily\s+convoyage/gi, 'Bathily-Convoyage');
    if (newContent !== originalContent) {
      fs.writeFileSync(filePath, newContent, 'utf8');
      console.log('Modifié: ' + filePath);
      modifiedFiles++;
    }
  }
});

console.log('Terminé. Fichiers modifiés: ' + modifiedFiles);
