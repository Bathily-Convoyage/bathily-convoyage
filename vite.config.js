import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const publicHtmlFiles = [
  '404.html',
  'blog.html',
  'blog/convoyage-ou-transport-camion.html',
  'blog/convoyage-vehicule-electrique.html',
  'bon-de-mission.html',
  'carte-visite.html',
  'contact.html',
  'convoyage-amiens.html',
  'convoyage-angers.html',
  'convoyage-annecy.html',
  'convoyage-besancon.html',
  'convoyage-bordeaux.html',
  'convoyage-caen.html',
  'convoyage-clermont-ferrand.html',
  'convoyage-dijon.html',
  'convoyage-electrique.html',
  'convoyage-grenoble.html',
  'convoyage-le-havre.html',
  'convoyage-limoges.html',
  'convoyage-luxe.html',
  'convoyage-lyon.html',
  'convoyage-lyon-marseille.html',
  'convoyage-marseille.html',
  'convoyage-metz.html',
  'convoyage-montpellier.html',
  'convoyage-moto-voiture-france.html',
  'convoyage-moto-voiture-paris.html',
  'convoyage-nancy.html',
  'convoyage-nimes.html',
  'convoyage-orleans.html',
  'convoyage-paris-bordeaux.html',
  'convoyage-paris-lyon.html',
  'convoyage-paris-marseille.html',
  'convoyage-perpignan.html',
  'convoyage-reims.html',
  'convoyage-rouen.html',
  'convoyage-saint-etienne.html',
  'convoyage-toulon.html',
  'convoyage-toulouse.html',
  'convoyage-tours.html',
  'convoyage-utilitaire.html',
  'convoyage-vehicule-lille.html',
  'convoyage-vehicule-nantes.html',
  'convoyage-vehicule-nice.html',
  'convoyage-vehicule-rennes.html',
  'convoyage-vehicule-strasbourg.html',
  'dashboard-admin.html',
  'dashboard-client.html',
  'dashboard-convoyeur.html',
  'dashboard-operator.html',
  'devis.html',
  'espace-pro.html',
  'etat-des-lieux.html',
  'formation-convoyeur.html',
  'gps-emitter.html',
  'index.html',
  'mentions-legales.html',
  'merci-devis.html',
  'mission-tracker.html',
  'qui-sommes-nous.html',
  'reset-password.html',
  'tracking.html',
  'unsubscribe.html'
];

export default defineConfig({
  publicDir: 'public',
  server: {
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  },
  build: {
    copyPublicDir: true,
    rollupOptions: {
      input: Object.fromEntries(publicHtmlFiles.map((file) => [file.replace(/\.html$/, ''), resolve(__dirname, file)])),
    }
  }
});
