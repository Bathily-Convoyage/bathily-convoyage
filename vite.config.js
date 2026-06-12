import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        devis: resolve(__dirname, 'devis.html'),
        contact: resolve(__dirname, 'contact.html'),
        dashboardAdmin: resolve(__dirname, 'dashboard-admin.html'),
        dashboardClient: resolve(__dirname, 'dashboard-client.html'),
        dashboardConvoyeur: resolve(__dirname, 'dashboard-convoyeur.html'),
        bonDeMission: resolve(__dirname, 'bon-de-mission.html'),
        etatDesLieux: resolve(__dirname, 'etat-des-lieux.html'),
        gpsEmitter: resolve(__dirname, 'gps-emitter.html'),
        tracking: resolve(__dirname, 'tracking.html'),
        mentionsLegales: resolve(__dirname, 'mentions-legales.html'),
        formationConvoyeur: resolve(__dirname, 'formation-convoyeur.html'),
        convoyageMotoVoitureFrance: resolve(__dirname, 'convoyage-moto-voiture-france.html'),
        convoyageMotoVoitureParis: resolve(__dirname, 'convoyage-moto-voiture-paris.html'),
        convoyageVehiculeLille: resolve(__dirname, 'convoyage-vehicule-lille.html'),
        convoyageVehiculeNantes: resolve(__dirname, 'convoyage-vehicule-nantes.html'),
        convoyageVehiculeStrasbourg: resolve(__dirname, 'convoyage-vehicule-strasbourg.html'),
        convoyageVehiculeNice: resolve(__dirname, 'convoyage-vehicule-nice.html'),
        convoyageVehiculeRennes: resolve(__dirname, 'convoyage-vehicule-rennes.html'),
        convoyageLyon: resolve(__dirname, 'convoyage-lyon.html'),
        convoyageMarseille: resolve(__dirname, 'convoyage-marseille.html'),
        convoyageBordeaux: resolve(__dirname, 'convoyage-bordeaux.html'),
        convoyageToulouse: resolve(__dirname, 'convoyage-toulouse.html'),
        convoyageMontpellier: resolve(__dirname, 'convoyage-montpellier.html'),
      }
    }
  }
});
