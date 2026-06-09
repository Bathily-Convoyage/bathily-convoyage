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
      }
    }
  }
});
