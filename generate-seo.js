import fs from 'fs';
import path from 'path';

const __dirname = path.resolve();

const cities = [
  {
    name: 'Paris',
    slug: 'paris',
    lat: 48.8566,
    lon: 2.3522,
    destName: 'Lyon',
    destLat: 45.7640,
    destLon: 4.8357,
    region: 'Île-de-France & France entière'
  },
  {
    name: 'Marseille',
    slug: 'marseille',
    lat: 43.2965,
    lon: 5.3698,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Provence-Alpes-Côte d\'Azur & France entière'
  },
  {
    name: 'Bordeaux',
    slug: 'bordeaux',
    lat: 44.8378,
    lon: -0.5792,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Nouvelle-Aquitaine & France entière'
  },
  {
    name: 'Toulouse',
    slug: 'toulouse',
    lat: 43.6047,
    lon: 1.4442,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Occitanie & France entière'
  },
  {
    name: 'Lille',
    slug: 'lille',
    lat: 50.6292,
    lon: 3.0573,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Hauts-de-France & France entière'
  },
  {
    name: 'Nantes',
    slug: 'nantes',
    lat: 47.2184,
    lon: -1.5536,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Pays de la Loire & France entière'
  },
  {
    name: 'Strasbourg',
    slug: 'strasbourg',
    lat: 48.5734,
    lon: 7.7521,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Grand Est & France entière'
  },
  {
    name: 'Nice',
    slug: 'nice',
    lat: 43.7102,
    lon: 7.2620,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Provence-Alpes-Côte d\'Azur & France entière'
  },
  {
    name: 'Montpellier',
    slug: 'montpellier',
    lat: 43.6108,
    lon: 3.8767,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Occitanie & France entière'
  },
  {
    name: 'Rennes',
    slug: 'rennes',
    lat: 48.1173,
    lon: -1.6778,
    destName: 'Paris',
    destLat: 48.8566,
    destLon: 2.3522,
    region: 'Bretagne & France entière'
  }
];

const templatePath = path.join(__dirname, 'convoyage-moto-lyon.html');
const templateContent = fs.readFileSync(templatePath, 'utf8');

console.log('Generating SEO pages...');

const viteInputs = {};

cities.forEach(city => {
  let content = templateContent;

  // Replace title & metadata
  content = content.replace(
    /Convoyage Auto & Moto Lyon \| Transport Sécurisé de Véhicules \| Bathily Convoyage/g,
    `Convoyage Auto & Moto ${city.name} | Transport Sécurisé de Véhicules | Bathily Convoyage`
  );
  content = content.replace(
    /depuis ou vers Lyon \?/g,
    `depuis ou vers ${city.name} ?`
  );
  content = content.replace(
    /à Lyon en toute sécurité\./g,
    `à ${city.name} en toute sécurité.`
  );

  // Replace badge and H1
  content = content.replace(
    /✨ Spécialiste Lyon & Rhône-Alpes/g,
    `✨ Spécialiste ${city.name}`
  );
  content = content.replace(
    /Convoyage Auto & Moto Lyon : <span>Votre véhicule livré<\/span>/g,
    `Convoyage Auto & Moto ${city.name} : <span>Votre véhicule livré</span>`
  );

  // Replace default inputs
  content = content.replace(
    /value="Lyon, France"/g,
    `value="${city.name}, France"`
  );

  // Replace descriptions & body texts
  content = content.replace(
    /de Lyon vers toute la France/g,
    `de ${city.name} vers toute la France`
  );
  content = content.replace(
    /depuis ou vers Lyon est/g,
    `depuis ou vers ${city.name} est`
  );
  content = content.replace(
    /en concession à Lyon,/g,
    `en concession à ${city.name},`
  );
  content = content.replace(
    /professionnel à Lyon,/g,
    `professionnel à ${city.name},`
  );
  content = content.replace(
    /en région lyonnaise/g,
    `en région de ${city.name}`
  );
  content = content.replace(
    /depuis Lyon, un/g,
    `depuis ${city.name}, un`
  );
  content = content.replace(
    /expédier votre véhicule depuis Lyon \?/g,
    `expédier votre véhicule depuis ${city.name} ?`
  );
  content = content.replace(
    /Questions fréquentes — Convoyage Lyon/g,
    `Questions fréquentes — Convoyage ${city.name}`
  );
  content = content.replace(
    /votre voiture ou moto à Lyon<\/div>/g,
    `votre voiture ou moto à ${city.name}</div>`
  );
  content = content.replace(
    /organiser un transport depuis Lyon \?/g,
    `organiser un transport depuis ${city.name} ?`
  );
  content = content.replace(
    /Rhône-Alpes & France entière/g,
    `${city.region}`
  );
  content = content.replace(
    /Suivez le convoyeur en temps réel depuis Lyon/g,
    `Suivez le convoyeur en temps réel depuis ${city.name}`
  );

  // Replace Leaflet map script coordinates
  // Template: const map = L.map('miniMap').setView([45.7640, 4.8357], 6);
  content = content.replace(
    /setView\(\[45\.7640, 4\.8357\], 6\)/g,
    `setView([${city.lat}, ${city.lon}], 6)`
  );
  
  // Template: L.marker([45.7640, 4.8357]).addTo(map).bindPopup('Lyon').openPopup();
  content = content.replace(
    /L\.marker\(\[45\.7640, 4\.8357\]\)\.addTo\(map\)\.bindPopup\('Lyon'\)\.openPopup\(\);/g,
    `L.marker([${city.lat}, ${city.lon}]).addTo(map).bindPopup('${city.name}').openPopup();`
  );

  // Template: L.marker([48.8566, 2.3522]).addTo(map).bindPopup('Paris');
  content = content.replace(
    /L\.marker\(\[48\.8566, 2\.3522\]\)\.addTo\(map\)\.bindPopup\('Paris'\);/g,
    `L.marker([${city.destLat}, ${city.destLon}]).addTo(map).bindPopup('${city.destName}');`
  );

  // Template: L.polyline([[45.7640, 4.8357], [48.8566, 2.3522]], ...
  content = content.replace(
    /\[\[45\.7640, 4\.8357\], \[48\.8566, 2\.3522\]\]/g,
    `[[${city.lat}, ${city.lon}], [${city.destLat}, ${city.destLon}]]`
  );

  const fileName = `convoyage-vehicule-${city.slug}.html`;
  fs.writeFileSync(path.join(__dirname, fileName), content, 'utf8');
  console.log(`Generated ${fileName}`);

  viteInputs[`convoyageVehicule${city.name}`] = `resolve(__dirname, '${fileName}')`;
});

console.log('\nUpdating vite.config.js...');
const configPath = path.join(__dirname, 'vite.config.js');
let configContent = fs.readFileSync(configPath, 'utf8');

// Insert new entry points before the closing bracket of rollupOptions.input
let inputBlockMatch = configContent.match(/input:\s*\{([^}]+)\}/);
if (inputBlockMatch) {
  let entries = inputBlockMatch[1].trim().split('\n');
  
  // Clean existing auto generated entries to avoid duplicates
  entries = entries.filter(e => !e.includes('convoyageVehicule'));

  // Add new entries
  cities.forEach(city => {
    const key = `convoyageVehicule${city.name}`;
    const val = `resolve(__dirname, 'convoyage-vehicule-${city.slug}.html')`;
    entries.push(`        ${key}: ${val},`);
  });

  const newInputBlock = `input: {\n        ${entries.map(e => e.trim()).join('\n        ')}\n      }`;
  configContent = configContent.replace(/input:\s*\{([^}]+)\}/, newInputBlock);
  fs.writeFileSync(configPath, configContent, 'utf8');
  console.log('vite.config.js updated successfully!');
} else {
  console.error('Could not find input block in vite.config.js');
}
