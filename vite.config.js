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
        convoyageMotoLyon: resolve(__dirname, 'convoyage-moto-lyon.html'),
        convoyageMotoVoitureFrance: resolve(__dirname, 'convoyage-moto-voiture-france.html'),
        convoyageVehiculeParis: resolve(__dirname, 'convoyage-vehicule-paris.html'),
        convoyageVehiculeMarseille: resolve(__dirname, 'convoyage-vehicule-marseille.html'),
        convoyageVehiculeBordeaux: resolve(__dirname, 'convoyage-vehicule-bordeaux.html'),
        convoyageVehiculeToulouse: resolve(__dirname, 'convoyage-vehicule-toulouse.html'),
        convoyageVehiculeLille: resolve(__dirname, 'convoyage-vehicule-lille.html'),
        convoyageVehiculeNantes: resolve(__dirname, 'convoyage-vehicule-nantes.html'),
        convoyageVehiculeStrasbourg: resolve(__dirname, 'convoyage-vehicule-strasbourg.html'),
        convoyageVehiculeNice: resolve(__dirname, 'convoyage-vehicule-nice.html'),
        convoyageVehiculeMontpellier: resolve(__dirname, 'convoyage-vehicule-montpellier.html'),
        convoyageVehiculeRennes: resolve(__dirname, 'convoyage-vehicule-rennes.html'),
      }
    }
  }
});
