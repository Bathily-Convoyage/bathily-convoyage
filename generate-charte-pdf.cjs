// generate-charte-pdf.cjs
// Script pour générer le PDF de la charte graphique à partir du HTML

const puppeteer = require('puppeteer');
const path = require('path');

async function generateChartePDF() {
    console.log('🎨 Génération du PDF de la charte graphique...');

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();

        // Charger le fichier HTML
        const htmlPath = path.join(__dirname, 'charte-graphique-complete.html');
        await page.goto(`file://${htmlPath}`, {
            waitUntil: 'networkidle0'
        });

        // Attendre que les polices soient chargées
        await page.evaluateHandle('document.fonts.ready');

        // Générer le PDF
        const pdfPath = path.join(__dirname, 'charte-graphique-bathily-complete.pdf');
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20mm',
                right: '15mm',
                bottom: '20mm',
                left: '15mm'
            },
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `
        <div style="font-size: 9px; color: #6B625A; text-align: center; width: 100%; padding: 0 15mm;">
          <span>Charte Graphique Bathily Convoyage v2.0 - Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>
      `
        });

        console.log('✅ PDF généré avec succès !');
        console.log(`📄 Fichier: ${pdfPath}`);

    } catch (error) {
        console.error('❌ Erreur lors de la génération du PDF:', error);
        throw error;
    } finally {
        await browser.close();
    }
}

// Exécuter la génération
generateChartePDF()
    .then(() => {
        console.log('🎉 Processus terminé avec succès !');
        process.exit(0);
    })
    .catch((error) => {
        console.error('💥 Échec de la génération:', error);
        process.exit(1);
    });
