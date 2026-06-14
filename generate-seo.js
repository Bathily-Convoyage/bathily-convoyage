import fs from 'fs';
import path from 'path';

const __dirname = path.resolve();

// Let's clean up old generated files to keep git tidy
const filesToDelete = [
  'convoyage-moto-lyon.html',
  'convoyage-vehicule-paris.html',
  'convoyage-vehicule-marseille.html',
  'convoyage-vehicule-bordeaux.html',
  'convoyage-vehicule-toulouse.html',
  'convoyage-vehicule-montpellier.html'
];

filesToDelete.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`Deleted old file: ${file}`);
  }
});

const cities = [
  {
    name: 'Lyon',
    slug: 'lyon',
    fileName: 'convoyage-lyon.html',
    lat: 45.7640,
    lon: 4.8357,
    region: 'Auvergne-Rhône-Alpes & France entière',
    routes: [
      { name: 'Paris', lat: 48.8566, lon: 2.3522, color: '#0A4D68' },
      { name: 'Marseille', lat: 43.2965, lon: 5.3698, color: '#4A7C6B' }
    ],
    faqQuestion: 'Puis-je faire prendre en charge mon véhicule aux gares Part-Dieu ou Perrache ?',
    faqAnswer: '<strong>Oui, absolument.</strong> Nos convoyeurs lyonnais se déplacent directement devant les déposes-minutes de Lyon Part-Dieu et Lyon Perrache, ou dans les communes de la métropole (Villeurbanne, Bron, Écully, Saint-Priest, etc.) pour récupérer ou livrer votre voiture ou votre moto.'
  },
  {
    name: 'Marseille',
    slug: 'marseille',
    fileName: 'convoyage-marseille.html',
    lat: 43.2965,
    lon: 5.3698,
    region: 'Provence-Alpes-Côte d\'Azur & France entière',
    routes: [
      { name: 'Paris', lat: 48.8566, lon: 2.3522, color: '#0A4D68' },
      { name: 'Lyon', lat: 45.7640, lon: 4.8357, color: '#4A7C6B' }
    ],
    faqQuestion: 'Gérez-vous la prise en charge au port maritime pour les transferts vers la Corse ?',
    faqAnswer: '<strong>Oui, tout à fait.</strong> Nous assurons régulièrement des liaisons avec le grand port maritime de Marseille (GPMM) pour récupérer ou déposer des véhicules (autos et motos) en transit ferry vers la Corse ou l\'Afrique du Nord. Nous coordonnons l\'accès avec les compagnies maritimes.'
  },
  {
    name: 'Bordeaux',
    slug: 'bordeaux',
    fileName: 'convoyage-bordeaux.html',
    lat: 44.8378,
    lon: -0.5792,
    region: 'Nouvelle-Aquitaine & France entière',
    routes: [
      { name: 'Paris', lat: 48.8566, lon: 2.3522, color: '#0A4D68' },
      { name: 'Toulouse', lat: 43.6047, lon: 1.4442, color: '#4A7C6B' }
    ],
    faqQuestion: 'Prenez-vous en charge les véhicules dans les châteaux et vignobles du Bordelais ?',
    faqAnswer: '<strong>Oui, tout à fait.</strong> En plus de la gare Saint-Jean et de l\'aéroport de Mérignac, nos convoyeurs professionnels interviennent dans les domaines viticoles et les communes environnantes (Saint-Émilion, Pessac, Libourne, bassin d\'Arcachon) pour sécuriser le rapatriement de votre voiture ou deux-roues.'
  },
  {
    name: 'Toulouse',
    slug: 'toulouse',
    fileName: 'convoyage-toulouse.html',
    lat: 43.6047,
    lon: 1.4442,
    region: 'Occitanie & France entière',
    routes: [
      { name: 'Paris', lat: 48.8566, lon: 2.3522, color: '#0A4D68' },
      { name: 'Bordeaux', lat: 44.8378, lon: -0.5792, color: '#4A7C6B' }
    ],
    faqQuestion: 'Livrez-vous les véhicules sur la zone aéronautique de Blagnac ?',
    faqAnswer: '<strong>Oui, régulièrement.</strong> Nous collaborons avec de nombreux professionnels de l\'aéronautique à Toulouse. Nos convoyeurs assurent la livraison de flottes et de véhicules individuels à la gare Matabiau, à l\'aéroport de Blagnac, ainsi que sur les différents sites d\'Airbus.'
  },
  {
    name: 'Montpellier',
    slug: 'montpellier',
    fileName: 'convoyage-montpellier.html',
    lat: 43.6108,
    lon: 3.8767,
    region: 'Occitanie & France entière',
    routes: [
      { name: 'Paris', lat: 48.8566, lon: 2.3522, color: '#0A4D68' },
      { name: 'Marseille', lat: 43.2965, lon: 5.3698, color: '#4A7C6B' }
    ],
    faqQuestion: 'Livrez-vous dans les stations balnéaires autour de Montpellier ?',
    faqAnswer: '<strong>Oui, absolument.</strong> Notre équipe prend en charge et livre les voitures et motos dans Montpellier intra-muros (gare Saint-Roch, gare Sud de France) mais intervient aussi sur toute la bande côtière (La Grande-Motte, Carnon, Palavas-les-Flots, Sète, Agde).'
  }
];

const templatePath = path.join(__dirname, 'convoyage-moto-voiture-paris.html');
const templateContent = fs.readFileSync(templatePath, 'utf8');

console.log('Generating customized SEO pages based on Paris template...');

cities.forEach(city => {
  let content = templateContent;

  // 1. General replacements
  content = content.replace(/Paris/g, city.name);
  content = content.replace(/paris/g, city.slug);
  content = content.replace(/Île-de-France/g, city.region.split('&')[0].trim());
  content = content.replace(/Île-de-France & France entière/g, city.region);
  content = content.replace(/parisiens/g, `${city.slug}iens`);

  // 2. Specific routes
  const route1 = city.routes[0];
  const route2 = city.routes[1];
  
  // Replace titles for routes
  content = content.replace(
    /vers Lyon, Marseille ou toute la France/g,
    `vers ${route1.name}, ${route2.name} ou toute la France`
  );
  content = content.replace(
    /trajet Paris-Lyon ou Paris-Marseille/g,
    `trajet ${city.name}-${route1.name} ou ${city.name}-${route2.name}`
  );
  content = content.replace(
    /liaisons régulières depuis Paris/g,
    `liaisons régulières depuis ${city.name}`
  );
  content = content.replace(
    /Exemples de tracés vers Lyon et Marseille\./g,
    `Exemples de tracés vers ${route1.name} et ${route2.name}.`
  );
  content = content.replace(
    /un convoyage Paris ➔ Lyon ou Paris ➔ Marseille \?/g,
    `un convoyage ${city.name} ➔ ${route1.name} ou ${city.name} ➔ ${route2.name} ?`
  );
  content = content.replace(
    /Paris-Lyon et Paris-Marseille/g,
    `${city.name}-${route1.name} et ${city.name}-${route2.name}`
  );

  // 3. Local FAQ specific question
  const targetFAQ = `Prenez-vous en charge mon véhicule directement dans un parking à ${city.name} ?`;
  content = content.replace(targetFAQ, city.faqQuestion);
  
  const targetFAQAnswer = `Nos convoyeurs ${city.slug}iens se déplacent dans tous les types de parkings à ${city.name} (parkings sous-terrains publics Indigo, parkings résidentiels étroits, gares, aéroports ou concessions). Nous gérons la récupération des clés et le règlement ou la validation des tickets de parking comme convenu préalablement avec vous.`;
  content = content.replace(targetFAQAnswer, city.faqAnswer);

  // 4. Map settings
  content = content.replace(
    /setView\(\[48\.8566, 2\.3522\], 6\)/g,
    `setView([${city.lat}, ${city.lon}], 6)`
  );
  content = content.replace(
    /L\.marker\(\[48\.8566, 2\.3522\]\)\.addTo\(map\)\.bindPopup\('Paris \(Départ\)'\)\.openPopup\(\);/g,
    `L.marker([${city.lat}, ${city.lon}]).addTo(map).bindPopup('${city.name} (Départ)').openPopup();`
  );
  content = content.replace(
    /L\.marker\(\[45\.7640, 4\.8357\]\)\.addTo\(map\)\.bindPopup\('Lyon'\);/g,
    `L.marker([${route1.lat}, ${route1.lon}]).addTo(map).bindPopup('${route1.name}');`
  );
  content = content.replace(
    /L\.marker\(\[43\.2965, 5\.3698\]\)\.addTo\(map\)\.bindPopup\('Marseille'\);/g,
    `L.marker([${route2.lat}, ${route2.lon}]).addTo(map).bindPopup('${route2.name}');`
  );
  
  content = content.replace(
    /\[48\.8566, 2\.3522\], \[45\.7640, 4\.8357\]/g,
    `[${city.lat}, ${city.lon}], [${route1.lat}, ${route1.lon}]`
  );
  content = content.replace(
    /\[48\.8566, 2\.3522\], \[43\.2965, 5\.3698\]/g,
    `[${city.lat}, ${city.lon}], [${route2.lat}, ${route2.lon}]`
  );

  fs.writeFileSync(path.join(__dirname, city.fileName), content, 'utf8');
  console.log(`Generated ${city.fileName}`);
});

console.log('\nUpdating vite.config.js...');
const configPath = path.join(__dirname, 'vite.config.js');
let configContent = fs.readFileSync(configPath, 'utf8');

// Find input object block
let inputBlockMatch = configContent.match(/input:\s*\{([^}]+)\}/);
if (inputBlockMatch) {
  let entries = inputBlockMatch[1].trim().split('\n');
  
  // Keep base files & others but clean up the ones we are replacing/adding
  const baseKeysToRemove = [
    'convoyageMotoLyon',
    'convoyageVehiculeParis',
    'convoyageVehiculeMarseille',
    'convoyageVehiculeBordeaux',
    'convoyageVehiculeToulouse',
    'convoyageVehiculeMontpellier',
    'convoyageLyon',
    'convoyageMarseille',
    'convoyageBordeaux',
    'convoyageToulouse',
    'convoyageMontpellier'
  ];

  entries = entries.filter(e => {
    const key = e.split(':')[0].trim();
    return !baseKeysToRemove.includes(key);
  });

  // Add updated entries
  cities.forEach(city => {
    const key = `convoyage${city.name}`;
    const val = `resolve(__dirname, '${city.fileName}')`;
    entries.push(`        ${key}: ${val},`);
  });

  const newInputBlock = `input: {\n        ${entries.map(e => e.trim()).join('\n        ')}\n      }`;
  configContent = configContent.replace(/input:\s*\{([^}]+)\}/, newInputBlock);
  fs.writeFileSync(configPath, configContent, 'utf8');
  console.log('vite.config.js updated successfully!');
} else {
  console.error('Could not find input block in vite.config.js');
}
