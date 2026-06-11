// generate-pdfs.cjs
const fs = require('fs');
const PDFDocument = require('pdfkit');

console.log('Début de la génération des PDF premium adaptés aux modèles d\'inspiration...');

// ============================================================================
// CONFIGURATION DE LA CHARTE GRAPHIQUE
// ============================================================================
const COLOR_BORDEAUX = '#7A2E1A';
const COLOR_BORDEAUX_DARK = '#5C2212';
const COLOR_CREAM = '#FDFBF7';
const COLOR_BEIGE = '#F9F6F0';
const COLOR_ANTHRACITE = '#2D2A24';
const COLOR_BORDER = '#E8E1D9';

// Helper to draw rounded images (clipping)
function drawRoundedImage(doc, path, x, y, w, h, r) {
  if (fs.existsSync(path)) {
    doc.save();
    doc.roundedRect(x, y, w, h, r).clip();
    doc.image(path, x, y, { width: w, height: h, cover: [w, h] });
    doc.restore();
  } else {
    doc.save();
    doc.roundedRect(x, y, w, h, r).strokeColor(COLOR_BORDER).stroke();
    doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(8);
    doc.text(`[Image ${path} non trouvée]`, x, y + h / 2 - 4, { align: 'center', width: w });
    doc.restore();
  }
}

// Helper to draw an image inside a rounded Arch (dome shape)
function drawArchImage(doc, path, x, y, w, h) {
  if (fs.existsSync(path)) {
    const r = w / 2; // Semi-circle radius
    doc.save();
    doc.moveTo(x, y + h)
       .lineTo(x, y + r)
       .arc(x + r, y + r, r, Math.PI, 0, false)
       .lineTo(x + w, y + h)
       .closePath()
       .clip();
    doc.image(path, x, y, { width: w, height: h, cover: [w, h] });
    doc.restore();
  } else {
    const r = w / 2;
    doc.save();
    doc.moveTo(x, y + h)
       .lineTo(x, y + r)
       .arc(x + r, y + r, r, Math.PI, 0, false)
       .lineTo(x + w, y + h)
       .closePath()
       .strokeColor(COLOR_BORDEAUX)
       .stroke();
    doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(8);
    doc.text(`[Image ${path} non trouvée]`, x, y + h / 2, { align: 'center', width: w });
    doc.restore();
  }
}

// Helper to draw an image inside a circle (with white border)
function drawCircularImage(doc, path, cx, cy, radius) {
  if (fs.existsSync(path)) {
    doc.save();
    doc.circle(cx, cy, radius).clip();
    const d = radius * 2;
    doc.image(path, cx - radius, cy - radius, { width: d, height: d, cover: [d, d] });
    doc.restore();
    
    // White border
    doc.save();
    doc.circle(cx, cy, radius).lineWidth(2).strokeColor('#FFFFFF').stroke();
    doc.restore();
  }
}

// Helper to draw a card with ONLY top corners rounded
function drawTopRoundedCard(doc, x, y, w, h, r, fillColor) {
  doc.save();
  doc.fillColor(fillColor);
  doc.moveTo(x, y + h)
     .lineTo(x, y + r)
     .quadraticCurveTo(x, y, x + r, y)
     .lineTo(x + w - r, y)
     .quadraticCurveTo(x + w, y, x + w, y + r)
     .lineTo(x + w, y + h)
     .closePath()
     .fill();
  doc.restore();
}

// Helper to draw a beautiful GPS Pin Vector
function drawGPSPin(doc, cx, cy, size = 1) {
  doc.save();
  doc.translate(cx, cy);
  doc.scale(size);
  
  // Outer circle pin shape
  doc.fillColor(COLOR_BORDEAUX);
  doc.moveTo(0, 0)
     .bezierCurveTo(-8, -8, -12, -16, -12, -24)
     .bezierCurveTo(-12, -32, -6, -38, 0, -38)
     .bezierCurveTo(6, -38, 12, -32, 12, -24)
     .bezierCurveTo(12, -16, 8, -8, 0, 0)
     .fill();
     
  // Inner white dot
  doc.fillColor(COLOR_CREAM);
  doc.circle(0, -24, 4.5).fill();
  doc.restore();
}

// Helper to draw the official brand logo emblem in white vector
function drawBrandEmblem(doc, cx, cy, size = 1) {
  doc.save();
  doc.translate(cx, cy);
  doc.scale(size);
  
  // Cercle extérieur (Boussole / Volant)
  doc.lineWidth(1.8).strokeColor('#FFFFFF');
  doc.circle(0, -20, 16).stroke();
  
  // Repères cardinaux (ticks de boussole)
  doc.fillColor('#FFFFFF');
  doc.rect(-1, -39, 2, 6).fill(); // Nord
  doc.rect(-1, -7, 2, 6).fill();  // Sud
  doc.rect(-19, -21, 6, 2).fill(); // Ouest
  doc.rect(13, -21, 6, 2).fill();  // Est
  
  // Aiguille centrale (GPS pin fusionné)
  doc.moveTo(0, -32)
     .lineTo(7, -13)
     .lineTo(0, -18)
     .lineTo(-7, -13)
     .closePath()
     .fill();
     
  doc.restore();
}

// Helper to draw a contact icon box with white symbol
function drawContactIconBox(doc, x, y, type) {
  // Box bordeaux arrondie
  doc.save();
  doc.fillColor(COLOR_BORDEAUX);
  doc.roundedRect(x, y, 14, 14, 3).fill();
  
  // Symbole blanc intérieur
  doc.strokeColor('#FFFFFF').lineWidth(0.8);
  if (type === 'phone') {
    // Dessin simple téléphone
    doc.fillColor('#FFFFFF');
    doc.roundedRect(x + 5, y + 3, 4, 8, 1).fill();
  } else if (type === 'mail') {
    // Dessin enveloppe
    doc.rect(x + 3, y + 4.5, 8, 5).stroke();
    doc.moveTo(x + 3, y + 4.5).lineTo(x + 7, y + 7.5).lineTo(x + 11, y + 4.5).stroke();
  } else if (type === 'web') {
    // Dessin globe
    doc.circle(x + 7, y + 7, 3.5).stroke();
    doc.moveTo(x + 7, y + 3.5).lineTo(x + 7, y + 10.5).stroke();
  } else if (type === 'gps') {
    // Dessin repère GPS
    doc.fillColor('#FFFFFF');
    doc.circle(x + 7, y + 6, 2).fill();
    doc.moveTo(x + 7, y + 8).lineTo(x + 5, y + 11).lineTo(x + 9, y + 11).closePath().fill();
  }
  doc.restore();
}

// ============================================================================
// 1. GENERATION DE LA CHARTE GRAPHIQUE (LIVRE DE MARQUE)
// ============================================================================
function generateCharteGraphique() {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const stream = fs.createWriteStream('charte-graphique-bathily.pdf');
  doc.pipe(stream);

  // --- PAGE 1 : COUVERTURE ---
  doc.rect(0, 0, 595.28, 841.89).fill(COLOR_BORDEAUX);

  // Logo Blanc
  if (fs.existsSync('logo.png')) {
    doc.image('logo.png', 172.64, 250, { width: 250 });
  }

  doc.strokeColor(COLOR_CREAM).lineWidth(1).moveTo(200, 430).lineTo(395, 430).stroke();

  // Titre
  doc.fillColor(COLOR_CREAM);
  doc.font('Helvetica-Bold').fontSize(22).text('LIVRE DE MARQUE', 100, 470, { align: 'center', width: 400 });
  doc.font('Helvetica-Oblique').fontSize(14).text("Charte Graphique & Identité Visuelle", 100, 505, { align: 'center', width: 400 });
  doc.fillColor('#FFFFFF').font('Helvetica').fontSize(10).text('Version 1.0 — Juin 2026', 100, 750, { align: 'center', width: 400 });

  // --- PAGE 2 : VISION ---
  doc.addPage();
  doc.rect(0, 0, 595.28, 841.89).fill(COLOR_CREAM);
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(18).text('01. Vision & Positionnement', 40, 50);
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(40, 75).lineTo(555, 75).stroke();

  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(11).lineGap(5);
  doc.text("Bathily Convoyage est un service de convoyage automobile et moto haut de gamme en France.", 40, 110, { width: 515 });
  doc.text("Notre but est d'offrir une expérience utilisateur irréprochable qui se traduit par une sécurité maximale (Allianz), une transparence totale (suivi de mission GPS en temps réel) et un grand soin opérationnel (EDL photo certifié).", { width: 515 });

  // Image en arche
  drawArchImage(doc, 'car4.jpg', 122.64, 200, 350, 240);

  // Valeurs
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(13).text('Nos trois piliers fondamentaux :', 40, 490);
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(10).moveDown(0.5);
  doc.text("• Sécurité absolue : Double assurance Allianz sur-mesure.");
  doc.text("• Clarté technologique : Suivi en direct du véhicule par balise GPS.");
  doc.text("• Rigueur contradictoire : État des lieux complet avec photos géolocalisées.");

  doc.fontSize(8).fillColor(COLOR_BORDEAUX).text('Bathily Convoyage — Livre de Marque', 40, 800, { width: 515, align: 'left' });

  // --- PAGE 3 : LE LOGO ---
  doc.addPage();
  doc.rect(0, 0, 595.28, 841.89).fill(COLOR_CREAM);
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(18).text('02. Identité Visuelle - Logo', 40, 50);
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(40, 75).lineTo(555, 75).stroke();

  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(11).text("Le logo associe le nom de la marque à un emblème mêlant un volant stylisé et un marqueur GPS, rappelant l'activité de transport sécurisé et géolocalisé.", 40, 110, { width: 515 });

  if (fs.existsSync('logo.png')) {
    doc.image('logo.png', 172.64, 180, { width: 250 });
  }

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(13).text("Usages et Interdits :", 40, 480);
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(10).moveDown(0.5);
  doc.text("• Toujours utiliser le fichier officiel HD pour vos supports de communication.", { bulletRadius: 2 });
  doc.text("• Ne pas changer la couleur bordeaux sans autorisation de la charte.", { bulletRadius: 2 });
  doc.text("• Conserver une zone d'exclusion blanche d'au moins 2 cm autour du logo.", { bulletRadius: 2 });

  doc.fontSize(8).fillColor(COLOR_BORDEAUX).text('Bathily Convoyage — Livre de Marque', 40, 800, { width: 515, align: 'left' });

  // --- PAGE 4 : COULEURS ---
  doc.addPage();
  doc.rect(0, 0, 595.28, 841.89).fill(COLOR_CREAM);
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(18).text('03. Palette de Couleurs', 40, 50);
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(40, 75).lineTo(555, 75).stroke();

  const colors = [
    { name: 'Bordeaux Premium', hex: '#7A2E1A', usage: 'Éléments de marque, boutons d\'action, logo' },
    { name: 'Bordeaux Sombre', hex: '#5C2212', usage: 'Contraste, texte important, état de survol' },
    { name: 'Crème Douceur', hex: '#FDFBF7', usage: 'Fond principal de l\'application' },
    { name: 'Beige Léger', hex: '#F9F6F0', usage: 'Fonds secondaires et composants (cards)' },
    { name: 'Anthracite Chic', hex: '#2D2A24', usage: 'Texte principal de lecture' }
  ];

  let currentY = 110;
  colors.forEach(c => {
    doc.save();
    doc.roundedRect(40, currentY, 40, 40, 8).fill(c.hex);
    doc.restore();
    doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(12).text(c.name, 95, currentY + 6);
    doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(9.5).text(`HEX : ${c.hex}  |  Usage : ${c.usage}`, 95, currentY + 22);
    currentY += 55;
  });

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(14).text('Typographie', 40, 410);
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(10).moveDown(0.5);
  doc.text("• Titres : Plus Jakarta Sans (Gras, géométrique, moderne)", { bulletRadius: 2 });
  doc.text("• Corps : Inter (Sobre, hautement lisible sur mobile)", { bulletRadius: 2 });

  doc.fontSize(8).fillColor(COLOR_BORDEAUX).text('Bathily Convoyage — Livre de Marque', 40, 800, { width: 515, align: 'left' });

  // --- PAGE 5 : MAQUETTE CARTE ---
  doc.addPage();
  doc.rect(0, 0, 595.28, 841.89).fill(COLOR_CREAM);
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(18).text('04. Maquette Carte de Visite', 40, 50);
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(40, 75).lineTo(555, 75).stroke();

  if (fs.existsSync('carte-de-visite-mockup.png')) {
    doc.image('carte-de-visite-mockup.png', 72.64, 150, { width: 450 });
  }

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(12).text('Spécifications :', 40, 480);
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(10).moveDown(0.5);
  doc.text("• Angles arrondis physiques requis sur la carte (rayon 3mm ou 4mm).", { bulletRadius: 2 });
  doc.text("• Seule l'icône de suivi de mission GPS figure au verso.", { bulletRadius: 2 });
  doc.text("• Finition premium mat.", { bulletRadius: 2 });

  doc.fontSize(8).fillColor(COLOR_BORDEAUX).text('Bathily Convoyage — Livre de Marque', 40, 800, { width: 515, align: 'left' });

  // --- PAGE 6 : MAQUETTE PLAQUETTE ---
  doc.addPage();
  doc.rect(0, 0, 595.28, 841.89).fill(COLOR_CREAM);
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(18).text('05. Maquette Plaquette', 40, 50);
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(40, 75).lineTo(555, 75).stroke();

  if (fs.existsSync('plaquette-commerciale-mockup.png')) {
    doc.image('plaquette-commerciale-mockup.png', 72.64, 150, { width: 450 });
  }

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(12).text('Directives graphiques :', 40, 480);
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(10).moveDown(0.5);
  doc.text("• Les dépliants doivent comporter les visuels de voitures intégrés.", { bulletRadius: 2 });
  doc.text("• Utilisation intensive des formes arrondies pour les encadrés de texte.", { bulletRadius: 2 });

  doc.fontSize(8).fillColor(COLOR_BORDEAUX).text('Bathily Convoyage — Livre de Marque', 40, 800, { width: 515, align: 'left' });

  doc.end();
}

// ============================================================================
// 2. GENERATION DE LA CARTE DE VISITE (FICHIER IMPRESSION PRO)
// ============================================================================
function generateCarteDeVisitePrint() {
  // Format standard 85 x 55 mm + 2mm de fond perdu = 89 x 59 mm (252.28 x 167.24 points)
  const doc = new PDFDocument({
    size: [252.28, 167.24],
    margins: { top: 8, bottom: 8, left: 8, right: 8 }
  });
  
  const stream = fs.createWriteStream('carte-de-visite-print.pdf');
  doc.pipe(stream);

  // --- RECTO (Page 1) : Theme Sport & Tech de l'inspiration ---
  // Fond anthracite sombre
  doc.rect(0, 0, 252.28, 167.24).fill(COLOR_ANTHRACITE);

  // Vagues/Diagonales bordeaux à droite (Tracé Polygone)
  doc.save();
  doc.fillColor(COLOR_BORDEAUX_DARK);
  doc.moveTo(140, 0)
     .lineTo(252.28, 0)
     .lineTo(252.28, 167.24)
     .lineTo(100, 167.24)
     .closePath()
     .fill();
  doc.restore();

  doc.save();
  doc.fillColor(COLOR_BORDEAUX);
  doc.moveTo(165, 0)
     .lineTo(252.28, 0)
     .lineTo(252.28, 167.24)
     .lineTo(130, 167.24)
     .closePath()
     .fill();
  doc.restore();

  // Cercle photo voiture de sport à droite avec bordure blanche
  drawCircularImage(doc, 'car1.jpg', 195, 83.62, 42);

  // Logo officiel dessiné en blanc à gauche
  // drawBrandEmblem(doc, cx, cy, size)
  drawBrandEmblem(doc, 45, 55, 0.85);

  // Texte du logo à gauche
  doc.fillColor('#FFFFFF');
  doc.font('Helvetica-Bold').fontSize(16).text('Bathily.', 75, 40);
  doc.fontSize(7.5).fillColor(COLOR_BEIGE).font('Helvetica-Bold').text('CONVOYAGE', 75, 59, { characterSpacing: 2 });

  // Dessin repères angles arrondis de découpe
  doc.roundedRect(5.67, 5.67, 240.94, 155.9, 9).lineWidth(0.5).strokeColor('rgba(255,255,255,0.08)').stroke();


  // --- VERSO (Page 2) : Contact info sur fond anthracite ---
  doc.addPage();
  doc.rect(0, 0, 252.28, 167.24).fill(COLOR_ANTHRACITE);

  // Rappel discret des diagonales bordeaux à droite
  doc.save();
  doc.fillColor(COLOR_BORDEAUX);
  doc.moveTo(210, 0)
     .lineTo(252.28, 0)
     .lineTo(252.28, 167.24)
     .lineTo(180, 167.24)
     .closePath()
     .fill();
  doc.restore();

  // Repère d'angles arrondis
  doc.roundedRect(5.67, 5.67, 240.94, 155.9, 9).lineWidth(0.5).strokeColor('rgba(255,255,255,0.08)').stroke();

  // Titre "Contactez-nous"
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11).text('Contactez-nous', 25, 22);
  doc.fillColor(COLOR_BORDER).font('Helvetica-Oblique').fontSize(7.5).text('Bathily-Convoyage (Fondateur)', 25, 36);

  // Ligne fine blanche
  doc.strokeColor('rgba(255,255,255,0.15)').lineWidth(0.5).moveTo(25, 48).lineTo(185, 48).stroke();

  // Liste des coordonnées avec pastilles d'icônes bordeaux
  const coordYStart = 58;
  const items = [
    { type: 'phone', label: '+33 (0)7 67 21 51 00' },
    { type: 'mail', label: 'contact@bathily-convoyage.fr' },
    { type: 'web', label: 'bathily-convoyage.fr' },
    { type: 'gps', label: 'Suivi GPS de mission en direct' }
  ];

  let currY = coordYStart;
  items.forEach(item => {
    // Dessiner le petit bouton d'icône bordeaux
    drawContactIconBox(doc, 25, currY, item.type);
    
    // Écrire le texte à côté en blanc/gris
    doc.fillColor('#FFFFFF');
    if (item.type === 'web') {
      doc.font('Helvetica-Bold').fillColor(COLOR_BEIGE);
    } else {
      doc.font('Helvetica');
    }
    doc.fontSize(7.5).text(item.label, 47, currY + 3.5);
    currY += 21;
  });

  doc.end();
}

// ============================================================================
// 3. GENERATION DE LA PLAQUETTE COMMERCIALE (FICHIER IMPRESSION PRO)
// ============================================================================
function generatePlaquettePrint() {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 0, bottom: 0, left: 0, right: 0 }
  });

  const stream = fs.createWriteStream('plaquette-commerciale-print.pdf');
  doc.pipe(stream);

  const wVolet = 280.63;
  const hTotal = 595.28;

  // --- RECTO (Volet 5 | Volet 6 | Volet 1) ---
  doc.rect(0, 0, 841.89, hTotal).fill(COLOR_CREAM);

  // VOLET 5 : TEMOIGNAGES
  doc.rect(0, 0, wVolet, hTotal).fill(COLOR_BEIGE);
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(16).text('ILS NOUS FONT CONFIANCE', 25, 45, { width: 230 });
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(25, 65).lineTo(255, 65).stroke();

  drawArchImage(doc, 'car4.jpg', 25, 85, 230, 160);

  doc.save();
  doc.roundedRect(25, 265, 230, 105, 12).fill('#FFFFFF');
  doc.restore();
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica-Oblique').fontSize(9.5).lineGap(3).text('« Service irréprochable. Le suivi GPS m\'a permis de savoir exactement où était ma voiture. L\'état des lieux avec signature électronique est super rassurant. »', 35, 275, { width: 210 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR_BORDEAUX).text('— Jean D. (Particulier, Tesla)', 35, 345);

  doc.save();
  doc.roundedRect(25, 385, 230, 95, 12).fill('#FFFFFF');
  doc.restore();
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica-Oblique').fontSize(9.5).lineGap(3).text('« En tant que concessionnaire, j\'exige la ponctualité et le respect des véhicules. Bathily Convoyage répond parfaitement à nos exigences. »', 35, 395, { width: 210 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR_BORDEAUX).text('— Garage du Centre (Professionnel)', 35, 455);

  // VOLET 6 : DOS / CONTACT
  if (fs.existsSync('car2.jpg')) {
    doc.save();
    doc.rect(wVolet, 0, wVolet, hTotal).clip();
    doc.image('car2.jpg', wVolet, 0, { width: wVolet, height: hTotal, cover: [wVolet, hTotal] });
    doc.fillColor(COLOR_BORDEAUX).opacity(0.85).rect(wVolet, 0, wVolet, hTotal).fill();
    doc.restore();
  } else {
    doc.rect(wVolet, 0, wVolet, hTotal).fill(COLOR_BORDEAUX_DARK);
  }

  if (fs.existsSync('logo.png')) {
    doc.image('logo.png', wVolet + 40, 45, { width: 200 });
  }

  drawTopRoundedCard(doc, wVolet + 20, 160, 240, 435, 20, COLOR_CREAM);

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(14).text('NOUS CONTACTER', wVolet + 40, 195);
  doc.strokeColor(COLOR_BEIGE).lineWidth(1).moveTo(wVolet + 40, 215).lineTo(wVolet + 240, 215).stroke();

  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(10).lineGap(4);
  doc.text('Une question, un devis spécifique ou besoin d\'un partenaire régulier pour votre parc de véhicules ?', wVolet + 40, 230, { width: 200 });

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('Téléphone direct :', wVolet + 40, 305);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('+33 (0)7 67 21 51 00', wVolet + 40, 320);

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('Adresse E-mail :', wVolet + 40, 360);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('contact@bathily-convoyage.fr', wVolet + 40, 375);

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('Site internet :', wVolet + 40, 415);
  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('bathily-convoyage.fr', wVolet + 40, 430);

  drawGPSPin(doc, wVolet + 140, 510, 1.1);

  // VOLET 1 : COUVERTURE
  doc.rect(wVolet * 2, 0, wVolet, hTotal).fill(COLOR_BORDEAUX);
  drawArchImage(doc, 'car1.jpg', wVolet * 2 + 25, 45, 230, 230);

  doc.fillColor('#FFFFFF');
  doc.font('Helvetica-Bold').fontSize(26).text('Bathily.', wVolet * 2 + 25, 305);
  doc.fontSize(10).font('Helvetica').text('C O N V O Y A G E', wVolet * 2 + 25, 337, { characterSpacing: 3 });

  doc.strokeColor(COLOR_CREAM).lineWidth(1).moveTo(wVolet * 2 + 25, 360).lineTo(wVolet * 2 + 255, 360).stroke();

  doc.fillColor(COLOR_CREAM).font('Helvetica-Bold').fontSize(19).lineGap(4);
  doc.text('Le convoyage de véhicules en toute sérénité.', wVolet * 2 + 25, 385, { width: 230 });
  doc.font('Helvetica').fontSize(10.5).fillColor('#FFFFFF').text('Pour les professionnels et particuliers exigeants.', wVolet * 2 + 25, 475, { width: 230 });

  doc.strokeColor(COLOR_BORDER).lineWidth(0.5).dash(4, { space: 4 });
  doc.moveTo(wVolet, 0).lineTo(wVolet, hTotal).stroke();
  doc.moveTo(wVolet * 2, 0).lineTo(wVolet * 2, hTotal).stroke();
  doc.undash();

  // --- VERSO ---
  doc.addPage();
  doc.rect(0, 0, 841.89, hTotal).fill(COLOR_CREAM);

  // VOLET 2 : PRESTATIONS
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(16).text('NOS PRESTATIONS', 25, 45, { width: 230 });
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(25, 65).lineTo(255, 65).stroke();

  doc.save();
  doc.roundedRect(20, 80, 240, 275, 16).fill('#FFFFFF');
  doc.restore();

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(11).lineGap(2);
  doc.text('1. Par la route', 35, 95);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).fontSize(9.5).text('Nos convoyeurs certifiés prennent le volant de votre véhicule. Option la plus économique et rapide.', 35, 110, { width: 210 });

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('2. Sur plateau', 35, 175);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('Transport sur camion porte-voiture. Idéal pour véhicules de collection, non assurés, ou non roulants.', 35, 190, { width: 210 });

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('3. Deux-roues', 35, 255);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('Transfert sécurisé de vos motos et scooters sur remorque adaptée ou par la route.', 35, 270, { width: 210 });

  drawArchImage(doc, 'car2.jpg', 25, 370, 230, 195);

  // VOLET 3 : GARANTIE & TECH
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(16).text('SÉCURITÉ & TECHNOLOGIE', wVolet + 25, 45, { width: 230 });
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(wVolet + 25, 65).lineTo(wVolet + 255, 65).stroke();

  doc.save();
  doc.roundedRect(wVolet + 20, 80, 240, 275, 16).fill('#FFFFFF');
  doc.restore();

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(11).lineGap(2);
  doc.text('🛡️  Double Assurance Allianz', wVolet + 35, 95);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).fontSize(9.5).text('Votre véhicule est couvert à 100% contre le vol, l\'incendie et les dommages grâce à notre contrat RC Pro Allianz dédié.', wVolet + 35, 110, { width: 210 });

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('📸  État des Lieux Numérique (EDL)', wVolet + 35, 175);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('Inspection contradictoire départ/arrivée via notre application, avec 20+ photos HD géolocalisées et signée électroniquement.', wVolet + 35, 190, { width: 210 });

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('🗺️  Suivi GPS en Temps Réel', wVolet + 35, 255);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('Un lien unique et sécurisé vous est partagé au départ pour suivre en direct la position géographique de votre véhicule.', wVolet + 35, 270, { width: 210 });

  drawArchImage(doc, 'car4.jpg', wVolet + 25, 370, 230, 195);

  // VOLET 4 : TARIFS
  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(16).text('NOS TARIFS', wVolet * 2 + 25, 45, { width: 230 });
  doc.strokeColor(COLOR_BORDER).lineWidth(1).moveTo(wVolet * 2 + 25, 65).lineTo(wVolet * 2 + 255, 65).stroke();

  doc.save();
  doc.roundedRect(wVolet * 2 + 20, 80, 240, 240, 16).fill('#FFFFFF');
  doc.restore();

  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(9.5).lineGap(3);
  doc.text('Tarification transparente à partir de 1,00 € HT / km parcouru, avec un forfait minimum de 120 € HT par transfert.', wVolet * 2 + 35, 95, { width: 210 });

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('• Formule Starter', wVolet * 2 + 35, 145);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('Convoyage + Assurance + Lavage express extérieur.', wVolet * 2 + 45, 160, { width: 200 });

  doc.font('Helvetica-Bold').fillColor(COLOR_BORDEAUX).text('• Formule Premium', wVolet * 2 + 35, 210);
  doc.font('Helvetica').fillColor(COLOR_ANTHRACITE).text('Starter + Lavage intérieur/extérieur complet + Niveau de carburant complété.', wVolet * 2 + 45, 225, { width: 200 });

  // Zone Promo Dotted
  doc.save();
  doc.roundedRect(wVolet * 2 + 20, 335, 240, 75, 12).fill(COLOR_BEIGE);
  doc.restore();
  
  doc.save();
  doc.roundedRect(wVolet * 2 + 25, 340, 230, 65, 8).lineWidth(1).dash(3, { space: 3 }).strokeColor(COLOR_BORDEAUX).stroke();
  doc.restore();

  doc.fillColor(COLOR_BORDEAUX).font('Helvetica-Bold').fontSize(8).text('CODE DE LANCEMENT -10%', wVolet * 2 + 35, 352, { align: 'center', width: 210 });
  doc.fontSize(14).text('HELLO10', wVolet * 2 + 35, 364, { align: 'center', width: 210 });
  doc.fillColor(COLOR_ANTHRACITE).font('Helvetica').fontSize(7.5).text('Valable sur votre premier devis en ligne', wVolet * 2 + 35, 384, { align: 'center', width: 210 });

  drawArchImage(doc, 'car3.jpg', wVolet * 2 + 25, 425, 230, 140);

  doc.strokeColor(COLOR_BORDER).lineWidth(0.5).dash(4, { space: 4 });
  doc.moveTo(wVolet, 0).lineTo(wVolet, hTotal).stroke();
  doc.moveTo(wVolet * 2, 0).lineTo(wVolet * 2, hTotal).stroke();
  doc.undash();

  doc.end();
}

// ============================================================================
// EXÉCUTION
// ============================================================================
try {
  generateCharteGraphique();
  generateCarteDeVisitePrint();
  generatePlaquettePrint();
  console.log('Tous les PDF premium adaptés avec succès !');
} catch (error) {
  console.error('Erreur générale de génération :', error);
}
