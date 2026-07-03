import puppeteer from 'puppeteer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dossier de sortie
const OUTPUT_DIR = path.join(path.dirname(__dirname), 'insta-v2');

// S'assurer que le dossier de sortie existe
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// SVGs en dur pour éviter les dépendances réseau et assurer une netteté vectorielle
const SVGS = {
  shield: `<svg viewBox="0 0 24 24" width="100" height="100" fill="none" stroke="#0A4D68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  gps: `<svg viewBox="0 0 24 24" width="100" height="100" fill="none" stroke="#088395" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" width="100" height="100" fill="none" stroke="#0A4D68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#4A7C6B" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  cross: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#D9534F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  car: `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#0A4D68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  moto: `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#0A4D68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="M12 18V9h4l2 5h3m-9-5H8l-2 4h-1"/></svg>`,
  star: `<svg viewBox="0 0 24 24" width="24" height="24" fill="#F5A623" stroke="#F5A623" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  quote: `<svg viewBox="0 0 24 24" width="60" height="60" fill="#E6F0F4" stroke="none"><path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z"/></svg>`,
};

// Base HTML Template
function getHTMLTemplate(contentHtml, styles = '') {
  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          width: 100%;
          height: 100%;
          font-family: 'Inter', sans-serif;
          background-color: #FDFBF7; /* Fond beige/crème clair signature */
          color: #2D2A24;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          align-items: center;
          position: relative;
          overflow: hidden;
          padding: 60px 80px;
        }
        
        /* En-tête */
        .header {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .logo {
          font-family: 'Montserrat', sans-serif;
          font-size: 28px;
          font-weight: 800;
          color: #2D2A24;
          text-decoration: none;
          letter-spacing: -0.02em;
        }
        .logo span {
          color: #F5A623; /* Point Jaune/Or */
        }
        .header-badge {
          background: #E6F0F4;
          color: #088395;
          padding: 8px 18px;
          border-radius: 40px;
          font-size: 14px;
          font-weight: 700;
          border: 1.5px solid rgba(8, 131, 149, 0.2);
          font-family: 'Montserrat', sans-serif;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        /* Corps principal */
        .main {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          width: 100%;
          text-align: center;
        }

        /* Pied de page */
        .footer {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-top: 30px;
          border-top: 1.5px solid #E8E1D9;
        }
        .footer-text {
          font-size: 16px;
          color: #6B625A;
          font-weight: 500;
        }
        .stars-container {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .stars-text {
          font-size: 14px;
          color: #2D2A24;
          font-weight: 700;
          margin-left: 6px;
        }

        /* Styles spécifiques des gabarits */
        ${styles}
      </style>
    </head>
    <body>
      ${contentHtml}
    </body>
    </html>
  `;
}

// Les données des différents visuels à générer
const VISUALS = [
  // ==========================================
  // CARROUSEL 1: POURQUOI BATHILY (1080x1350)
  // ==========================================
  {
    name: 'carousel1_slide1',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">⭐ 4.9/5 Google Reviews</div>
      </div>
      <div class="main">
        <span class="category-tag">TRANSPARENCE & FIABILITÉ</span>
        <h1 class="hero-title">Pourquoi confier votre véhicule à <strong>Bathily Convoyage</strong> ?</h1>
        <p class="hero-subtitle">Découvrez notre service de convoyage professionnel auto et moto partout en France.</p>
        <div class="road-visual">
          <div class="point point-a">Paris</div>
          <div class="line-animated">
            <div class="car-icon">${SVGS.car}</div>
          </div>
          <div class="point point-b">Marseille</div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour en savoir plus ➔</div>
        <div class="stars-container">
          ${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}
          <span class="stars-text">+500 avis</span>
        </div>
      </div>
    `, `
      .category-tag {
        font-family: 'Montserrat', sans-serif;
        font-size: 14px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.1em;
        margin-bottom: 20px;
        text-transform: uppercase;
      }
      .hero-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 52px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.2;
        max-width: 850px;
        margin-bottom: 24px;
      }
      .hero-title strong {
        color: #088395;
      }
      .hero-subtitle {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 700px;
        margin-bottom: 40px;
      }
      .road-visual {
        display: flex;
        align-items: center;
        width: 100%;
        max-width: 600px;
        justify-content: space-between;
        position: relative;
        margin-top: 20px;
      }
      .point {
        background: #0A4D68;
        color: white;
        padding: 8px 18px;
        border-radius: 20px;
        font-weight: 700;
        font-size: 16px;
        z-index: 2;
        font-family: 'Montserrat', sans-serif;
      }
      .line-animated {
        flex: 1;
        height: 4px;
        background: repeating-linear-gradient(90deg, #0A4D68, #0A4D68 10px, transparent 10px, transparent 20px);
        margin: 0 15px;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .car-icon {
        position: absolute;
        background: #FDFBF7;
        padding: 4px;
        border-radius: 50%;
        border: 2px solid #0A4D68;
        top: -20px;
      }
    `)
  },
  {
    name: 'carousel1_slide2',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">🛡️ Assurance Totale</div>
      </div>
      <div class="main">
        <div class="icon-circle">${SVGS.shield}</div>
        <h2 class="slide-title">Double RC Pro</h2>
        <p class="slide-desc">Votre véhicule est couvert à <strong>100% tous risques</strong> par notre double RC Pro (Bathily-Convoyage + convoyeur) pendant tout le convoyage. Aucune franchise à votre charge en cas de sinistre.</p>
        <div class="reassurance-card">
          <span class="card-badge">INCLUS SANS FRAIS</span>
          <h3>Responsabilité Civile Professionnelle</h3>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour la suite ➔</div>
        <div class="footer-text">RC Pro 🤝 Bathily</div>
      </div>
    `, `
      .icon-circle {
        width: 160px;
        height: 160px;
        background: #E6F0F4;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 30px;
      }
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 44px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 20px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 750px;
        margin-bottom: 40px;
      }
      .reassurance-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 20px;
        padding: 24px 40px;
        box-shadow: 0 10px 30px rgba(10, 77, 104, 0.05);
        display: inline-block;
      }
      .card-badge {
        font-size: 12px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.05em;
        display: block;
        margin-bottom: 6px;
      }
      .reassurance-card h3 {
        font-size: 20px;
        color: #0A4D68;
      }
    `)
  },
  {
    name: 'carousel1_slide3',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">📍 Traçabilité</div>
      </div>
      <div class="main">
        <div class="icon-circle shadow-secondary">${SVGS.gps}</div>
        <h2 class="slide-title">Suivi GPS en temps réel</h2>
        <p class="slide-desc">Suivez les déplacements de votre véhicule en direct depuis votre espace client. Des notifications SMS/e-mail automatiques vous informent à chaque étape clé du trajet.</p>
        <div class="map-mockup">
          <div class="map-track">
            <div class="map-dot active"></div>
            <div class="map-line"></div>
            <div class="map-dot"></div>
          </div>
          <div class="map-info">Chauffeur en route (Vitesse : 110 km/h)</div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour la suite ➔</div>
        <div class="footer-text">Traçabilité 100%</div>
      </div>
    `, `
      .icon-circle {
        width: 160px;
        height: 160px;
        background: #E6F0F4;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 30px;
      }
      .icon-circle.shadow-secondary {
        background: rgba(8, 131, 149, 0.1);
      }
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 44px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 20px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 750px;
        margin-bottom: 40px;
      }
      .map-mockup {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 20px;
        padding: 20px 30px;
        width: 100%;
        max-width: 500px;
        box-shadow: 0 10px 30px rgba(10, 77, 104, 0.05);
      }
      .map-track {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .map-dot {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #E8E1D9;
      }
      .map-dot.active {
        background: #088395;
        box-shadow: 0 0 0 6px rgba(8, 131, 149, 0.3);
      }
      .map-line {
        flex: 1;
        height: 4px;
        background: #088395;
        margin: 0 10px;
      }
      .map-info {
        font-size: 14px;
        color: #6B625A;
        font-weight: 600;
      }
    `)
  },
  {
    name: 'carousel1_slide4',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">📸 Transparence</div>
      </div>
      <div class="main">
        <div class="icon-circle">${SVGS.camera}</div>
        <h2 class="slide-title">État des lieux certifié</h2>
        <p class="slide-desc">Avant le départ et à la livraison, notre chauffeur effectue un état des lieux rigoureux avec <strong>20 photos géolocalisées et horodatées</strong>, signé numériquement par les deux parties.</p>
        <div class="photo-grid">
          <div class="photo-box">Face Avant</div>
          <div class="photo-box">Profil Droit</div>
          <div class="photo-box">Compteur</div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour la suite ➔</div>
        <div class="footer-text">Zéro litige</div>
      </div>
    `, `
      .icon-circle {
        width: 160px;
        height: 160px;
        background: #E6F0F4;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 30px;
      }
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 44px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 20px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 750px;
        margin-bottom: 40px;
      }
      .photo-grid {
        display: flex;
        gap: 15px;
        width: 100%;
        max-width: 500px;
      }
      .photo-box {
        flex: 1;
        background: white;
        border: 1.5px dashed #E8E1D9;
        border-radius: 12px;
        padding: 18px 10px;
        font-size: 14px;
        color: #6B625A;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    `)
  },
  {
    name: 'carousel1_slide5',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">⚡ Devis en 60s</div>
      </div>
      <div class="main">
        <h2 class="outro-title">Prêt à faire convoyer votre véhicule ?</h2>
        <p class="outro-desc">Obtenez votre estimation gratuite et immédiate sur notre site internet.</p>
        
        <div class="cta-card">
          <div class="mock-input">📍 Adresse de départ</div>
          <div class="mock-input">📍 Adresse d'arrivée</div>
          <div class="mock-tabs">
            <div class="mock-tab active">🚗 Automobile</div>
            <div class="mock-tab">🏍 Moto</div>
          </div>
          <div class="cta-btn">Estimer mon prix →</div>
        </div>

        <div class="domain-highlight">bathily-convoyage.fr</div>
      </div>
      <div class="footer">
        <div class="footer-text">Lien en bio 🌐</div>
        <div class="stars-container">
          ${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}
          <span class="stars-text">4.9/5</span>
        </div>
      </div>
    `, `
      .outro-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 48px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 16px;
        max-width: 800px;
      }
      .outro-desc {
        font-size: 22px;
        color: #6B625A;
        margin-bottom: 40px;
      }
      .cta-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 28px;
        padding: 30px;
        width: 100%;
        max-width: 500px;
        box-shadow: 0 15px 35px rgba(10, 77, 104, 0.08);
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 30px;
      }
      .mock-input {
        background: #FDFBF7;
        border: 1px solid #E8E1D9;
        border-radius: 40px;
        padding: 12px 20px;
        text-align: left;
        color: #6B625A;
        font-size: 16px;
      }
      .mock-tabs {
        display: flex;
        background: #FDFBF7;
        border: 1px solid #E8E1D9;
        border-radius: 40px;
        padding: 4px;
      }
      .mock-tab {
        flex: 1;
        padding: 10px;
        border-radius: 36px;
        font-size: 14px;
        font-weight: 600;
        color: #6B625A;
      }
      .mock-tab.active {
        background: #0A4D68;
        color: white;
      }
      .cta-btn {
        background: #F5A623;
        color: #0A4D68;
        font-weight: 700;
        padding: 14px;
        border-radius: 40px;
        font-size: 18px;
        box-shadow: 0 4px 10px rgba(245, 166, 35, 0.3);
      }
      .domain-highlight {
        font-family: 'Montserrat', sans-serif;
        font-size: 36px;
        font-weight: 800;
        color: #088395;
      }
    `)
  },

  // ==========================================
  // CARROUSEL 2: TARIFS & FOCUS PARIS-LYON (1080x1350)
  // ==========================================
  {
    name: 'carousel2_slide1',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">📍 Offre Spéciale</div>
      </div>
      <div class="main">
        <span class="route-badge">PARCOURS POPULAIRE</span>
        <h1 class="route-title">Paris ➔ Lyon</h1>
        <div class="features-pill-group">
          <div class="pill">🚗 Auto</div>
          <div class="pill">🏍 Moto</div>
          <div class="pill">📍 GPS temps réel</div>
        </div>
        <p class="route-desc">Votre véhicule convoyé de porte-à-porte par un chauffeur professionnel certifié.</p>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour voir le détail ➔</div>
        <div class="footer-text">AXA Assuré 🛡️</div>
      </div>
    `, `
      .route-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 14px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.1em;
        margin-bottom: 20px;
      }
      .route-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 64px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 24px;
      }
      .price-bubble {
        background: #F5A623;
        color: #0A4D68;
        padding: 24px 50px;
        border-radius: 100px;
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        margin-bottom: 30px;
        box-shadow: 0 12px 30px rgba(245, 166, 35, 0.3);
      }
      .price-val {
        font-family: 'Montserrat', sans-serif;
        font-size: 60px;
        font-weight: 800;
        line-height: 1;
      }
      .price-unit {
        font-size: 14px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .route-desc {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 700px;
        margin-bottom: 35px;
      }
      .features-pill-group {
        display: flex;
        gap: 15px;
      }
      .pill {
        background: white;
        border: 1px solid #E8E1D9;
        padding: 8px 20px;
        border-radius: 20px;
        font-size: 14px;
        font-weight: 700;
        color: #0A4D68;
      }
    `)
  },
  {
    name: 'carousel2_slide2',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">📦 Formule Route</div>
      </div>
      <div class="main">
        <h2 class="slide-title">Ce qui est inclus</h2>
        <p class="slide-desc">Pas de frais cachés, notre formule intègre l'ensemble de la logistique du transport.</p>
        
        <div class="inclusions-list">
          <div class="inclusion-item">
            <div class="check-icon">${SVGS.check}</div>
            <div>
              <h3>Chauffeur professionnel</h3>
              <p>Chauffeurs validés et assurés pour tout type de véhicule.</p>
            </div>
          </div>
          <div class="inclusion-item">
            <div class="check-icon">${SVGS.check}</div>
            <div>
              <h3>Carburant et péages autoroute</h3>
              <p>Tous les frais de route sont entièrement inclus dans le tarif.</p>
            </div>
          </div>
          <div class="inclusion-item">
            <div class="check-icon">${SVGS.check}</div>
            <div>
              <h3>Double RC Pro tous risques</h3>
              <p>Couverture de la valeur totale du véhicule sans surcoût.</p>
            </div>
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour comparer ➔</div>
        <div class="footer-text">Transparence totale</div>
      </div>
    `, `
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 44px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 16px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        margin-bottom: 40px;
      }
      .inclusions-list {
        display: flex;
        flex-direction: column;
        gap: 24px;
        width: 100%;
        max-width: 750px;
        text-align: left;
      }
      .inclusion-item {
        display: flex;
        gap: 20px;
        background: white;
        padding: 20px 24px;
        border-radius: 20px;
        border: 1.5px solid #E8E1D9;
        box-shadow: 0 6px 15px rgba(0, 0, 0, 0.02);
      }
      .check-icon {
        flex-shrink: 0;
        margin-top: 4px;
      }
      .inclusion-item h3 {
        font-size: 20px;
        color: #0A4D68;
        margin-bottom: 6px;
        font-family: 'Montserrat', sans-serif;
      }
      .inclusion-item p {
        font-size: 16px;
        color: #6B625A;
      }
    `)
  },
  {
    name: 'carousel2_slide3',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">📊 Comparatif</div>
      </div>
      <div class="main">
        <h2 class="slide-title">Convoyage vs Plateau</h2>
        <p class="slide-desc">Pourquoi le convoyage par la route est l'alternative idéale au transport sur camion.</p>
        
        <table class="compare-table">
          <thead>
            <tr>
              <th>Critère</th>
              <th class="highlight">Convoyage Route</th>
              <th>Transport Camion</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Livraison</strong></td>
              <td class="highlight-val">Porte-à-porte direct</td>
              <td>Dépôt logistique excentré</td>
            </tr>
            <tr>
              <td><strong>Flexibilité</strong></td>
              <td class="highlight-val">Date & heure sur mesure</td>
              <td>Délai variable (1 à 2 semaines)</td>
            </tr>
            <tr>
              <td><strong>Tarif</strong></td>
              <td class="highlight-val">Tarif sur mesure</td>
              <td>450€ - 650€ HT</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour réserver ➔</div>
        <div class="footer-text">Économique & Flexible</div>
      </div>
    `, `
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 44px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 16px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        margin-bottom: 40px;
      }
      .compare-table {
        width: 100%;
        max-width: 800px;
        border-collapse: collapse;
        background: white;
        border-radius: 20px;
        overflow: hidden;
        border: 1.5px solid #E8E1D9;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.03);
      }
      .compare-table th, .compare-table td {
        padding: 22px 24px;
        text-align: left;
        font-size: 16px;
        border-bottom: 1px solid #E8E1D9;
      }
      .compare-table th {
        background: #FDFBF7;
        color: #2D2A24;
        font-family: 'Montserrat', sans-serif;
        font-weight: 700;
      }
      .compare-table th.highlight {
        background: #0A4D68;
        color: white;
      }
      .compare-table td.highlight-val {
        color: #088395;
        font-weight: 700;
        background: rgba(8, 131, 149, 0.03);
      }
      .compare-table tr:last-child td {
        border-bottom: none;
      }
    `)
  },
  {
    name: 'carousel2_slide4',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">⚡ Devis Immédiat</div>
      </div>
      <div class="main">
        <span class="route-badge">OFFRE PARIS ➔ LYON</span>
        <h2 class="outro-title">Votre voiture livrée à Lyon</h2>
        <p class="outro-desc">Estimez n'importe quel autre trajet en France en quelques clics.</p>
        
        <div class="domain-highlight">bathily-convoyage.fr</div>
        <a class="cta-link" href="#">Lien direct en bio 🌐</a>
      </div>
      <div class="footer">
        <div class="footer-text">Simple • Rapide • Sûr</div>
        <div class="stars-container">
          ${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}
          <span class="stars-text">4.9/5</span>
        </div>
      </div>
    `, `
      .route-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 14px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.1em;
        margin-bottom: 16px;
      }
      .outro-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 48px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 20px;
        max-width: 800px;
      }
      .outro-desc {
        font-size: 22px;
        color: #6B625A;
        margin-bottom: 40px;
      }
      .domain-highlight {
        font-family: 'Montserrat', sans-serif;
        font-size: 48px;
        font-weight: 800;
        color: #0A4D68;
        background: #F5A623;
        padding: 18px 40px;
        border-radius: 50px;
        display: inline-block;
        box-shadow: 0 10px 25px rgba(245, 166, 35, 0.3);
        margin-bottom: 30px;
      }
      .cta-link {
        font-size: 18px;
        color: #088395;
        text-decoration: none;
        font-weight: 700;
      }
    `)
  },

  // ==========================================
  // CARROUSEL 3: COMMENT ÇA MARCHE (1080x1350)
  // ==========================================
  {
    name: 'carousel3_slide1',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">🛠️ Guide Pratique</div>
      </div>
      <div class="main">
        <span class="category-tag">PROCESSUS SIMPLIFIÉ</span>
        <h1 class="hero-title">Comment faire convoyer votre véhicule en <strong>3 étapes</strong> ?</h1>
        <p class="hero-subtitle">Notre service digitalisé rend le convoyage plus simple que jamais. Suivez le guide.</p>
        
        <div class="steps-preview">
          <div class="preview-step">1</div>
          <div class="preview-line"></div>
          <div class="preview-step">2</div>
          <div class="preview-line"></div>
          <div class="preview-step">3</div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour voir l'étape 1 ➔</div>
        <div class="stars-container">
          ${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}
          <span class="stars-text">Simple</span>
        </div>
      </div>
    `, `
      .category-tag {
        font-family: 'Montserrat', sans-serif;
        font-size: 14px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.1em;
        margin-bottom: 20px;
        text-transform: uppercase;
      }
      .hero-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 52px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.2;
        max-width: 850px;
        margin-bottom: 24px;
      }
      .hero-title strong {
        color: #F5A623;
      }
      .hero-subtitle {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 700px;
        margin-bottom: 50px;
      }
      .steps-preview {
        display: flex;
        align-items: center;
        width: 100%;
        max-width: 400px;
      }
      .preview-step {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: #0A4D68;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Montserrat', sans-serif;
        font-size: 24px;
        font-weight: 800;
      }
      .preview-line {
        flex: 1;
        height: 4px;
        background: #0A4D68;
        margin: 0 10px;
      }
    `)
  },
  {
    name: 'carousel3_slide2',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">Étape 1</div>
      </div>
      <div class="main">
        <div class="step-badge">1</div>
        <h2 class="slide-title">Devis immédiat & Réservation</h2>
        <p class="slide-desc">Rendez-vous sur notre site. Saisissez vos adresses et obtenez instantanément un <strong>tarif fixe et transparent</strong>. Validez votre commande en ligne.</p>
        
        <div class="step-card">
          <div class="mock-input">📍 Départ : Paris 75008</div>
          <div class="mock-input">📍 Arrivée : Lyon 69002</div>
          <div class="price-estimate">Tarif : sur devis</div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour l'étape 2 ➔</div>
        <div class="footer-text">Durée : 60 secondes</div>
      </div>
    `, `
      .step-badge {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: #F5A623;
        color: #0A4D68;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Montserrat', sans-serif;
        font-size: 36px;
        font-weight: 800;
        margin-bottom: 24px;
      }
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 40px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 16px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 750px;
        margin-bottom: 40px;
      }
      .step-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 20px;
        padding: 24px 30px;
        width: 100%;
        max-width: 450px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.03);
      }
      .mock-input {
        background: #FDFBF7;
        border: 1px solid #E8E1D9;
        border-radius: 40px;
        padding: 12px 20px;
        margin-bottom: 10px;
        text-align: left;
        color: #6B625A;
      }
      .price-estimate {
        font-weight: 700;
        color: #088395;
        font-size: 18px;
        margin-top: 10px;
      }
    `)
  },
  {
    name: 'carousel3_slide3',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">Étape 2</div>
      </div>
      <div class="main">
        <div class="step-badge">2</div>
        <h2 class="slide-title">Prise en charge & Trajet</h2>
        <p class="slide-desc">Notre convoyeur professionnel certifié récupère votre véhicule. Il réalise un <strong>état des lieux photo complet (20 points)</strong> sur son application avant de prendre la route.</p>
        
        <div class="trajet-card">
          <div class="badge-blue">📍 En transit</div>
          <div class="progress-bar-container">
            <div class="progress-bar"></div>
            <div class="car-indicator">${SVGS.car}</div>
          </div>
          <div class="trajet-labels">
            <span>Départ</span>
            <span>Arrivée</span>
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour l'étape 3 ➔</div>
        <div class="footer-text">Double RC Pro 🛡️</div>
      </div>
    `, `
      .step-badge {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: #F5A623;
        color: #0A4D68;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Montserrat', sans-serif;
        font-size: 36px;
        font-weight: 800;
        margin-bottom: 24px;
      }
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 40px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 16px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 750px;
        margin-bottom: 40px;
      }
      .trajet-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 20px;
        padding: 24px 30px;
        width: 100%;
        max-width: 450px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.03);
      }
      .badge-blue {
        background: #E6F0F4;
        color: #0A4D68;
        padding: 6px 14px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 700;
        display: inline-block;
        margin-bottom: 15px;
      }
      .progress-bar-container {
        height: 6px;
        background: #E8E1D9;
        border-radius: 3px;
        position: relative;
        margin-bottom: 15px;
      }
      .progress-bar {
        width: 60%;
        height: 100%;
        background: #088395;
        border-radius: 3px;
      }
      .car-indicator {
        position: absolute;
        left: 56%;
        top: -15px;
        background: white;
        border: 1.5px solid #088395;
        border-radius: 50%;
        padding: 2px;
      }
      .trajet-labels {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        color: #6B625A;
        font-weight: 600;
      }
    `)
  },
  {
    name: 'carousel3_slide4',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">Étape 3</div>
      </div>
      <div class="main">
        <div class="step-badge">3</div>
        <h2 class="slide-title">Suivi en direct & Livraison</h2>
        <p class="slide-desc">Suivez le trajet par GPS en temps réel. À l'arrivée, le chauffeur procède à la validation de la livraison et remet les clés en main propre.</p>
        
        <div class="livraison-card">
          <div class="livraison-checked">
            <span class="circle-check">${SVGS.check}</span>
            <div>
              <h3>Véhicule livré avec succès</h3>
              <p>Clés remises en main propre</p>
            </div>
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Défilez pour commencer ➔</div>
        <div class="footer-text">Suivi GPS inclus</div>
      </div>
    `, `
      .step-badge {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: #F5A623;
        color: #0A4D68;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Montserrat', sans-serif;
        font-size: 36px;
        font-weight: 800;
        margin-bottom: 24px;
      }
      .slide-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 40px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 16px;
      }
      .slide-desc {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 750px;
        margin-bottom: 40px;
      }
      .livraison-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 20px;
        padding: 24px 30px;
        width: 100%;
        max-width: 450px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.03);
      }
      .livraison-checked {
        display: flex;
        align-items: center;
        gap: 15px;
        text-align: left;
      }
      .circle-check {
        width: 40px;
        height: 40px;
        background: rgba(74, 124, 107, 0.1);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .livraison-checked h3 {
        font-size: 18px;
        color: #2d2a24;
        font-family: 'Montserrat', sans-serif;
      }
      .livraison-checked p {
        font-size: 14px;
        color: #6B625A;
      }
    `)
  },
  {
    name: 'carousel3_slide5',
    width: 1080,
    height: 1350,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">⚡ Commencer</div>
      </div>
      <div class="main">
        <h2 class="outro-title">Besoin de déplacer votre véhicule ?</h2>
        <p class="outro-desc">Estimez votre prix en 60 secondes sur notre site internet.</p>
        
        <div class="cta-circle">
          <span>DEVIS GRATUIT</span>
        </div>

        <div class="domain-highlight">bathily-convoyage.fr</div>
      </div>
      <div class="footer">
        <div class="footer-text">Lien en bio 🌐</div>
        <div class="stars-container">
          ${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}
          <span class="stars-text">100% Digital</span>
        </div>
      </div>
    `, `
      .outro-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 48px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 20px;
        max-width: 800px;
      }
      .outro-desc {
        font-size: 22px;
        color: #6B625A;
        margin-bottom: 40px;
      }
      .cta-circle {
        width: 160px;
        height: 160px;
        background: #F5A623;
        color: #0A4D68;
        font-weight: 800;
        font-family: 'Montserrat', sans-serif;
        font-size: 16px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 10px 25px rgba(245, 166, 35, 0.3);
        margin-bottom: 30px;
      }
      .domain-highlight {
        font-family: 'Montserrat', sans-serif;
        font-size: 38px;
        font-weight: 800;
        color: #0A4D68;
      }
    `)
  },

  // ==========================================
  // REELS COVERS (1080x1920)
  // ==========================================
  {
    name: 'reel1_cover',
    width: 1080,
    height: 1920,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">Reel #1</div>
      </div>
      <div class="main vertical-center">
        <span class="reel-badge">OFFRE TARIFAIRE</span>
        <h1 class="reel-title">Paris ➔ Lyon</h1>
        <p class="reel-subtitle">Découvrez les coulisses du convoyage professionnel et économisez sur vos trajets.</p>
        <div class="play-btn-circle">▶</div>
      </div>
      <div class="footer">
        <div class="footer-text">Cliquez pour regarder</div>
        <div class="footer-text">bathily-convoyage.fr</div>
      </div>
    `, `
      body {
        padding: 80px 80px;
      }
      .vertical-center {
        justify-content: center;
      }
      .reel-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 16px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        margin-bottom: 30px;
      }
      .reel-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 64px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.15;
        margin-bottom: 30px;
      }
      .reel-subtitle {
        font-size: 24px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 650px;
        margin-bottom: 50px;
      }
      .play-btn-circle {
        width: 100px;
        height: 100px;
        border-radius: 50%;
        background: #F5A623;
        color: #0A4D68;
        font-size: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding-left: 8px; /* Alignement optique du triangle */
        box-shadow: 0 10px 30px rgba(245, 166, 35, 0.4);
      }
    `)
  },
  {
    name: 'reel2_cover',
    width: 1080,
    height: 1920,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">Avis Clients</div>
      </div>
      <div class="main vertical-center">
        <span class="reel-badge">TÉMOIGNAGES</span>
        <h1 class="reel-title">Ce qu'ils pensent de nous</h1>
        
        <div class="quote-card">
          <div class="quote-icon">${SVGS.quote}</div>
          <p class="quote-text">"Excellente prestation. Suivi précis, communication fluide. Je recommande vivement Bathily-Convoyage."</p>
          <div class="quote-author">
            <span class="author-avatar">LM</span>
            <div>
              <strong>Laurent M.</strong>
              <span>Client Particulier</span>
            </div>
          </div>
        </div>

        <div class="rating-stars">
          ${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}
          <span class="stars-val">4.9/5</span>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Vidéo UGC Client</div>
        <div class="footer-text">+500 avis</div>
      </div>
    `, `
      body {
        padding: 80px 80px;
      }
      .vertical-center {
        justify-content: center;
      }
      .reel-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 16px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        margin-bottom: 30px;
      }
      .reel-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 60px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.15;
        margin-bottom: 40px;
      }
      .quote-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 28px;
        padding: 40px;
        text-align: left;
        width: 100%;
        max-width: 600px;
        box-shadow: 0 15px 35px rgba(10, 77, 104, 0.06);
        position: relative;
        margin-bottom: 40px;
      }
      .quote-icon {
        margin-bottom: 20px;
      }
      .quote-text {
        font-size: 22px;
        font-style: italic;
        color: #2D2A24;
        line-height: 1.6;
        margin-bottom: 30px;
      }
      .quote-author {
        display: flex;
        align-items: center;
        gap: 15px;
      }
      .author-avatar {
        width: 60px;
        height: 60px;
        background: #E6F0F4;
        color: #0A4D68;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 18px;
      }
      .quote-author strong {
        display: block;
        font-size: 18px;
        color: #2D2A24;
      }
      .quote-author span {
        font-size: 14px;
        color: #6B625A;
      }
      .rating-stars {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .stars-val {
        font-weight: 800;
        font-size: 20px;
        color: #2D2A24;
        margin-left: 10px;
      }
    `)
  },
  {
    name: 'reel3_cover',
    width: 1080,
    height: 1920,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">Reel #3</div>
      </div>
      <div class="main vertical-center">
        <span class="reel-badge">CONSEILS DE ROUTE</span>
        <h1 class="reel-title">3 raisons de ne pas faire la route vous-même</h1>
        <p class="reel-subtitle">Fatigue, péages, carburant, temps perdu... Découvrez pourquoi nos clients préfèrent voyager l'esprit léger.</p>
        
        <div class="reasons-preview-list">
          <div class="reason-preview-item">
            <span class="reason-num">1</span>
            <span>Sécurité & Fatigue</span>
          </div>
          <div class="reason-preview-item">
            <span class="reason-num">2</span>
            <span>Coût global caché</span>
          </div>
          <div class="reason-preview-item">
            <span class="reason-num">3</span>
            <span>Aucune assurance</span>
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Cliquez pour regarder</div>
        <div class="footer-text">bathily-convoyage.fr</div>
      </div>
    `, `
      body {
        padding: 80px 80px;
      }
      .vertical-center {
        justify-content: center;
      }
      .reel-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 16px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        margin-bottom: 30px;
      }
      .reel-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 56px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.15;
        margin-bottom: 30px;
      }
      .reel-subtitle {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 650px;
        margin-bottom: 40px;
      }
      .reasons-preview-list {
        display: flex;
        flex-direction: column;
        gap: 15px;
        width: 100%;
        max-width: 500px;
        text-align: left;
      }
      .reason-preview-item {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 20px;
        padding: 16px 24px;
        display: flex;
        align-items: center;
        gap: 15px;
        font-size: 18px;
        font-weight: 700;
        color: #0A4D68;
      }
      .reason-num {
        width: 32px;
        height: 32px;
        background: #F5A623;
        color: #0A4D68;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: 16px;
      }
    `)
  },

  // ==========================================
  // STORIES (1080x1920)
  // ==========================================
  {
    name: 'story_devis_poll',
    width: 1080,
    height: 1920,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">📍 Estimation</div>
      </div>
      <div class="main vertical-center">
        <span class="story-badge">SONDAGE</span>
        <h1 class="story-title">Besoin de déplacer votre voiture ou moto ?</h1>
        <p class="story-subtitle">Calculez votre tarif en 60 secondes en toute transparence.</p>
        
        <div class="poll-placeholder">
          <!-- Espace réservé pour le sticker Sondage d'Instagram -->
          <div class="poll-box">Sondage Instagram</div>
          <div class="poll-text">Placez votre sticker ici</div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Glissez vers le haut ➔</div>
        <div class="footer-text">bathily-convoyage.fr</div>
      </div>
    `, `
      body {
        padding: 80px 80px;
      }
      .vertical-center {
        justify-content: center;
      }
      .story-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 16px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        margin-bottom: 24px;
      }
      .story-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 56px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.15;
        margin-bottom: 24px;
      }
      .story-subtitle {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 650px;
        margin-bottom: 60px;
      }
      .poll-placeholder {
        width: 100%;
        max-width: 500px;
        border: 2px dashed #088395;
        border-radius: 20px;
        padding: 40px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: rgba(8, 131, 149, 0.02);
      }
      .poll-box {
        background: #088395;
        color: white;
        padding: 12px 30px;
        border-radius: 50px;
        font-weight: 700;
        margin-bottom: 10px;
        font-size: 18px;
      }
      .poll-text {
        font-size: 14px;
        color: #6B625A;
        font-weight: 600;
      }
    `)
  },
  {
    name: 'story_avis_5stars',
    width: 1080,
    height: 1920,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">⭐ Preuve Sociale</div>
      </div>
      <div class="main vertical-center">
        <span class="story-badge">AVIS CLIENT</span>
        <h1 class="story-title">Un service validé par nos clients</h1>
        
        <div class="quote-card">
          <div class="quote-stars">
            ${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}${SVGS.star}
          </div>
          <p class="quote-text">"Excellente prestation. Suivi précis, communication fluide. Je recommande vivement Bathily-Convoyage."</p>
          <div class="quote-author">
            <span class="author-avatar">LM</span>
            <div>
              <strong>Laurent M.</strong>
              <span>Particulier (Paris ➔ Marseille)</span>
            </div>
          </div>
        </div>

        <div class="trustpilot-rating">
          <span>Noté <strong>4.9/5</strong> sur Google Reviews</span>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Lien en bio 🌐</div>
        <div class="footer-text">bathily-convoyage.fr</div>
      </div>
    `, `
      body {
        padding: 80px 80px;
      }
      .vertical-center {
        justify-content: center;
      }
      .story-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 16px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        margin-bottom: 24px;
      }
      .story-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 56px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.15;
        margin-bottom: 40px;
      }
      .quote-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 28px;
        padding: 40px;
        text-align: left;
        width: 100%;
        max-width: 600px;
        box-shadow: 0 15px 35px rgba(10, 77, 104, 0.06);
        margin-bottom: 40px;
      }
      .quote-stars {
        display: flex;
        gap: 4px;
        margin-bottom: 20px;
      }
      .quote-text {
        font-size: 22px;
        font-style: italic;
        color: #2D2A24;
        line-height: 1.6;
        margin-bottom: 30px;
      }
      .quote-author {
        display: flex;
        align-items: center;
        gap: 15px;
      }
      .author-avatar {
        width: 60px;
        height: 60px;
        background: #E6F0F4;
        color: #0A4D68;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 18px;
      }
      .quote-author strong {
        display: block;
        font-size: 18px;
        color: #2D2A24;
      }
      .quote-author span {
        font-size: 14px;
        color: #6B625A;
      }
      .trustpilot-rating {
        font-size: 16px;
        color: #6B625A;
      }
      .trustpilot-rating strong {
        color: #0A4D68;
      }
    `)
  },
  {
    name: 'story_ville_du_jour',
    width: 1080,
    height: 1920,
    html: getHTMLTemplate(`
      <div class="header">
        <div class="logo">Bathily-Convoyage<span>.</span></div>
        <div class="header-badge">Marseille 🌴</div>
      </div>
      <div class="main vertical-center">
        <span class="story-badge">VILLE DU JOUR</span>
        <h1 class="story-title">Votre véhicule livré à Marseille</h1>
        <p class="story-subtitle">Vacances, déménagement ou achat ? Nos convoyeurs livrent votre véhicule clé en main directement à destination.</p>
        
        <div class="marseille-card">
          <div class="marseille-icon">${SVGS.car}</div>
          <div class="marseille-route">Partout en France ➔ Marseille</div>
          <div class="marseille-price">Devis gratuit en 60s</div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-text">Glissez vers le haut ➔</div>
        <div class="footer-text">bathily-convoyage.fr</div>
      </div>
    `, `
      body {
        padding: 80px 80px;
      }
      .vertical-center {
        justify-content: center;
      }
      .story-badge {
        font-family: 'Montserrat', sans-serif;
        font-size: 16px;
        font-weight: 700;
        color: #088395;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        margin-bottom: 24px;
      }
      .story-title {
        font-family: 'Montserrat', sans-serif;
        font-size: 56px;
        font-weight: 800;
        color: #0A4D68;
        line-height: 1.15;
        margin-bottom: 24px;
      }
      .story-subtitle {
        font-size: 22px;
        color: #6B625A;
        line-height: 1.6;
        max-width: 650px;
        margin-bottom: 50px;
      }
      .marseille-card {
        background: white;
        border: 1.5px solid #E8E1D9;
        border-radius: 28px;
        padding: 35px;
        width: 100%;
        max-width: 500px;
        box-shadow: 0 15px 35px rgba(10, 77, 104, 0.06);
        text-align: center;
      }
      .marseille-icon {
        margin-bottom: 15px;
        display: inline-block;
        background: #E6F0F4;
        padding: 15px;
        border-radius: 50%;
      }
      .marseille-route {
        font-family: 'Montserrat', sans-serif;
        font-size: 20px;
        font-weight: 800;
        color: #0A4D68;
        margin-bottom: 10px;
      }
      .marseille-price {
        color: #F5A623;
        font-weight: 700;
        font-size: 16px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    `)
  }
];

// Fonction principale de génération des visuels
async function run() {
  console.log('🚀 Lancement de la génération automatique des visuels Instagram...');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    for (const visual of VISUALS) {
      console.log(`📸 Rendu de ${visual.name} (${visual.width}x${visual.height})...`);
      
      // Ajuster la taille de la zone d'affichage
      await page.setViewport({
        width: visual.width,
        height: visual.height,
        deviceScaleFactor: 2 // Améliore la netteté et la qualité du texte (retina)
      });

      // Charger le code HTML
      await page.setContent(visual.html, {
        waitUntil: 'load'
      });

      // Attendre le chargement des polices Google
      await page.evaluateHandle('document.fonts.ready');

      // Prendre une capture d'écran PNG non compressée en buffer
      const pngBuffer = await page.screenshot({
        type: 'png',
        fullPage: false
      });

      // Compresser avec Sharp au format JPEG optimisé
      const outputFilename = `${visual.name}.jpg`;
      const outputPath = path.join(OUTPUT_DIR, outputFilename);

      await sharp(pngBuffer)
        .jpeg({ quality: 90, mozjpeg: true })
        .toFile(outputPath);

      const stats = fs.statSync(outputPath);
      const sizeKb = (stats.size / 1024).toFixed(1);
      
      console.log(`✅ Fichier généré : ${outputFilename} (${sizeKb} ko)`);
    }

    // Génération automatique du fichier CAPTIONS.md
    console.log('✍️ Création du fichier CAPTIONS.md...');
    const captionsContent = `# Légendes Instagram - Campagne v2

Retrouvez ici toutes les légendes (captions) prêtes à copier-coller accompagnant vos nouveaux visuels Instagram v2.

---

## 📂 CARROUSEL 1 : "Pourquoi choisir Bathily Convoyage"
**Fichiers** : \`carousel1_slide1.jpg\` à \`carousel1_slide5.jpg\`

### 📝 Légende :
> 🚗 Devoir faire des centaines de kilomètres pour déplacer votre véhicule est souvent source de fatigue, de stress et de frais imprévus.
> 
> Pourquoi ne pas déléguer cette tâche à des professionnels ?
> 
> Chez **Bathily Convoyage**, nous assurons un transport simple, transparent et sécurisé de votre véhicule :
> 🛡️ **Double RC Pro tous risques** incluse (Bathily-Convoyage + convoyeur, aucune franchise à votre charge).
> 📍 **Suivi GPS en temps réel** pour garder un œil sur votre auto/moto tout au long du trajet.
> 📸 **État des lieux numérique certifié** avec 20 photos haute définition au départ et à l'arrivée.
> 
> Voyagez l'esprit tranquille, nous prenons le volant pour vous !
> 
> 👉 Estimez votre tarif en 60 secondes chrono sur notre site : **bathily-convoyage.fr** (lien direct en bio).
> 
> #convoyageauto #convoyage #transportvehicule #suivigps #rcpro #transitvoiture #carsofinstagram #bathilyconvoyage

---

## 📂 CARROUSEL 2 : "Focus Trajet Paris ➔ Lyon"
**Fichiers** : \`carousel2_slide1.jpg\` à \`carousel2_slide4.jpg\`

### 📝 Légende :
> 🚅 Besoin de déplacer votre véhicule entre Paris et Lyon ? 
> 
> Notre formule intègre l'ensemble de la logistique du transport :
> 
> Ce qui est compris :
> 👨‍✈️ Un chauffeur professionnel dédié.
> ⛽ Tous les frais de carburant et de péages d'autoroute.
> 🛡️ La couverture double RC Pro tous risques (Bathily-Convoyage + convoyeur).
> 📍 Le suivi de position GPS en direct.
> 
> Moins de tracas, plus rapide et plus flexible qu'un transport par camion plateau classique. Vous décidez du lieu et de l'heure exacte de livraison !
> 
> 👉 Réservez votre trajet ou estimez une autre ville en 1 minute : **bathily-convoyage.fr**
> 
> #convoyageauto #parislyon #lyon #paris #offredumoment #transitauto #voiturelyon #convoyeurpro #bathilyconvoyage

---

## 📂 CARROUSEL 3 : "Processus en 3 étapes"
**Fichiers** : \`carousel3_slide1.jpg\` à \`carousel3_slide5.jpg\`

### 📝 Légende :
> 🛠️ Comment fonctionne le convoyage de véhicule avec Bathily Convoyage ? C'est simple comme bonjour ! 
> 
> En seulement 3 étapes, votre véhicule est pris en charge et livré :
> 
> 1️⃣ **Estimation & Réservation** : Saisissez vos adresses de départ et d'arrivée sur notre site. Le tarif calculé est fixe et transparent. Validez en 1 clic.
> 2️⃣ **Prise en charge** : Le chauffeur partenaire se présente. Il effectue un état des lieux complet avec notre application (20 photos certifiées) et démarre le trajet.
> 3️⃣ **Livraison & Suivi** : Suivez le déplacement par GPS en direct. Les clés vous sont remises en main propre avec signature numérique.
> 
> Zéro stress, 100% digital, 100% sécurisé.
> 
> 👉 Obtenez votre devis immédiat gratuit : **bathily-convoyage.fr**
> 
> #convoyageauto #processus #transportvoiture #digitalisation #suivigps #facile #reassurance #clientroi #bathilyconvoyage

---

## 🎬 REELS COVERS
**Fichiers** : \`reel1_cover.jpg\`, \`reel2_cover.jpg\`, \`reel3_cover.jpg\`

*Ces couvertures sont destinées à être appliquées sur vos publications vidéo Reels de 15 secondes.*

### 📝 Légende pour Reel #1 (Hook Prix Paris-Lyon) :
> Besoin de faire convoyer votre voiture de Paris à Lyon sans lever le petit doigt et entièrement assuré ? Découvrez comment fonctionne le convoyage par la route ! 🚗💨
> 👉 Lien en bio : **bathily-convoyage.fr**

### 📝 Légende pour Reel #2 (UGC Témoignages) :
> Plus de 500 avis clients et une note exceptionnelle de 4.9/5 ! ⭐ Merci pour votre confiance quotidienne. Découvrez le témoignage en vidéo de Laurent M. sur son expérience avec nos convoyeurs professionnels. 💬
> 👉 Lien en bio : **bathily-convoyage.fr**

### 📝 Légende pour Reel #3 (3 Raisons) :
> Fatigue au volant, embouteillages interminables, coûts d'autoroute et d'essence cachés... Voici 3 raisons pour lesquelles faire la route vous-même n'est pas toujours la bonne option. Faites confiance à Bathily Convoyage ! 🛡️
> 👉 Lien en bio : **bathily-convoyage.fr**

---

## 📸 STORIES
**Fichiers** : \`story_devis_poll.jpg\`, \`story_avis_5stars.jpg\`, \`story_ville_du_jour.jpg\`

*Conseil d'utilisation :*
* Pour \`story_devis_poll.jpg\`, ajoutez le **sticker de sondage Instagram** ("Oui / Non" ou "Intéressé ?") directement sur l'emplacement réservé.
* Pour les stories, utilisez le **sticker de lien** d'Instagram pointant vers : \`https://www.bathily-convoyage.fr/devis.html\`.
`;

    fs.writeFileSync(path.join(OUTPUT_DIR, 'CAPTIONS.md'), captionsContent, 'utf8');
    console.log('✅ Fichier CAPTIONS.md créé avec succès !');

    console.log('🎉 Tous les visuels Instagram v2 ont été générés avec succès !');

  } catch (err) {
    console.error('❌ Une erreur est survenue lors de la génération :', err);
    throw err;
  } finally {
    await browser.close();
  }
}

run();
