import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

export async function exportGSCData() {
  const gCredentialsString = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const siteUrl = 'https://bathily-convoyage.fr/';

  if (!gCredentialsString) {
    console.warn('GOOGLE_APPLICATION_CREDENTIALS is missing. Using mockup GSC data.');
    return getMockGSCData();
  }

  try {
    const credentials = JSON.parse(gCredentialsString);

    const auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/webmasters.readonly']
    );

    const searchconsole = google.searchconsole({
      version: 'v1',
      auth,
    });

    // Dates for the last 7 days (yesterday down to 7 days ago)
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);

    const formatDate = (d) => d.toISOString().split('T')[0];
    const startDate = formatDate(sevenDaysAgo);
    const endDate = formatDate(yesterday);

    console.log(`Querying GSC API for ${siteUrl} from ${startDate} to ${endDate}...`);

    // 1. Query global metrics (over the period)
    const globalResponse = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        rowLimit: 1,
      },
    });

    let globalMetrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    if (globalResponse.data.rows && globalResponse.data.rows.length > 0) {
      const row = globalResponse.data.rows[0];
      globalMetrics = {
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: parseFloat(((row.ctr || 0) * 100).toFixed(2)),
        position: parseFloat((row.keys?.[0] ? 0 : row.position || 0).toFixed(1)), // average position
      };
    }

    // 2. Query page-level performance
    const pagesResponse = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['page'],
        rowLimit: 50,
      },
    });

    const pages = [];
    if (pagesResponse.data.rows) {
      for (const row of pagesResponse.data.rows) {
        const pageUrl = row.keys?.[0] || '';
        // Only include homepage and city pages (/convoyage-*.html)
        if (
          pageUrl === siteUrl ||
          pageUrl === `${siteUrl}index.html` ||
          pageUrl.includes('/convoyage-')
        ) {
          // Normalize names
          let pageName = 'Accueil';
          if (pageUrl.includes('convoyage-')) {
            pageName = pageUrl.split('/').pop().replace('.html', '').replace('convoyage-', 'Convoyage ');
            pageName = pageName.charAt(0).toUpperCase() + pageName.slice(1);
          }
          
          pages.push({
            page: pageUrl,
            name: pageName,
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
            ctr: parseFloat(((row.ctr || 0) * 100).toFixed(2)),
            position: parseFloat((row.position || 0).toFixed(1)),
          });
        }
      }
    }

    // 3. Query query-level performance
    const queriesResponse = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: 15,
      },
    });

    const queries = [];
    if (queriesResponse.data.rows) {
      for (const row of queriesResponse.data.rows) {
        queries.push({
          query: row.keys?.[0] || '',
          clicks: row.clicks || 0,
          impressions: row.impressions || 0,
          ctr: parseFloat(((row.ctr || 0) * 100).toFixed(2)),
          position: parseFloat((row.position || 0).toFixed(1)),
        });
      }
    }

    // Recalculate average position based on pages if global failed
    if (globalMetrics.position === 0 && pages.length > 0) {
      const avgPos = pages.reduce((acc, curr) => acc + curr.position, 0) / pages.length;
      globalMetrics.position = parseFloat(avgPos.toFixed(1));
    }

    return {
      period: `${startDate} au ${endDate}`,
      global: {
        clicks: globalMetrics.clicks,
        impressions: globalMetrics.impressions,
        ctr: globalMetrics.ctr,
        position: globalMetrics.position,
      },
      pages: pages.sort((a, b) => b.clicks - a.clicks),
      queries: queries.sort((a, b) => b.clicks - a.clicks),
    };

  } catch (err) {
    console.error(`Error querying GSC API: ${err.message}. Falling back to mockup data.`);
    return getMockGSCData();
  }
}

// Mockup fallback data when credentials are not available (e.g. local run or before setup)
function getMockGSCData() {
  const today = new Date();
  const format = (d) => d.toISOString().split('T')[0];
  const end = new Date(today);
  end.setDate(today.getDate() - 1);
  const start = new Date(today);
  start.setDate(today.getDate() - 7);

  return {
    period: `${format(start)} au ${format(end)} (MOCK)`,
    global: {
      clicks: 450,
      impressions: 12000,
      ctr: 3.75,
      position: 12.4,
    },
    pages: [
      {
        page: 'https://www.bathily-convoyage.fr/',
        name: 'Accueil',
        clicks: 220,
        impressions: 5500,
        ctr: 4.0,
        position: 8.5,
      },
      {
        page: 'https://www.bathily-convoyage.fr/convoyage-moto-voiture-paris.html',
        name: 'Convoyage Moto Voiture Paris',
        clicks: 80,
        impressions: 1800,
        ctr: 4.4,
        position: 5.2,
      },
      {
        page: 'https://www.bathily-convoyage.fr/convoyage-bordeaux.html',
        name: 'Convoyage Bordeaux',
        clicks: 45,
        impressions: 1200,
        ctr: 3.8,
        position: 12.3,
      },
      {
        page: 'https://www.bathily-convoyage.fr/convoyage-lyon.html',
        name: 'Convoyage Lyon',
        clicks: 35,
        impressions: 1100,
        ctr: 3.2,
        position: 14.1,
      },
      {
        page: 'https://www.bathily-convoyage.fr/convoyage-marseille.html',
        name: 'Convoyage Marseille',
        clicks: 30,
        impressions: 950,
        ctr: 3.2,
        position: 15.2,
      },
      {
        page: 'https://www.bathily-convoyage.fr/convoyage-toulouse.html',
        name: 'Convoyage Toulouse',
        clicks: 25,
        impressions: 800,
        ctr: 3.1,
        position: 16.0,
      },
      {
        page: 'https://www.bathily-convoyage.fr/convoyage-montpellier.html',
        name: 'Convoyage Montpellier',
        clicks: 15,
        impressions: 650,
        ctr: 2.3,
        position: 18.4,
      },
    ],
    queries: [
      {
        query: 'convoyage voiture',
        clicks: 110,
        impressions: 1500,
        ctr: 7.3,
        position: 3.4,
      },
      {
        query: 'convoyage moto paris',
        clicks: 75,
        impressions: 800,
        ctr: 9.4,
        position: 2.1,
      },
      {
        query: 'convoyeur voiture tarif',
        clicks: 40,
        impressions: 650,
        ctr: 6.2,
        position: 5.6,
      },
      {
        query: 'convoyage moto france',
        clicks: 30,
        impressions: 500,
        ctr: 6.0,
        position: 4.8,
      },
    ],
  };
}
