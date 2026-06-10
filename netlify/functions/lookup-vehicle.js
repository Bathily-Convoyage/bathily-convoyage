// netlify/functions/lookup-vehicle.js

exports.handler = async (event, context) => {
  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Méthode non autorisée. Utilisez GET.' })
    };
  }

  try {
    const { plaque } = event.queryStringParameters || {};

    if (!plaque) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Le paramètre plaque est requis.' })
      };
    }

    // Formater la plaque (nettoyage des tirets, espaces et conversion en majuscules)
    // Exemple : AA-123-AA -> AA123AA
    const formattedPlate = plaque.toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (formattedPlate.length < 4) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Format de plaque invalide.' })
      };
    }

    // Clé RapidAPI : Utilise la variable Netlify ou la clé de test par défaut
    const rapidApiKey = process.env.RAPIDAPI_KEY || '52a3036a5fmsh844f4d087cf7176p18fb51jsnd081c211f2cc';
    const host = 'api-siv-systeme-d-immatriculation-des-vehicules.p.rapidapi.com';

    console.log(`🔍 Interrogation SIV pour la plaque : ${formattedPlate}`);

    const response = await fetch(`https://${host}/${formattedPlate}`, {
      method: 'GET',
      headers: {
        'x-rapidapi-host': host,
        'x-rapidapi-key': rapidApiKey,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erreur API SIV:', data);
      throw new Error(data.message || `Erreur de communication avec l'API SIV (${response.status})`);
    }

    console.log('Données brutes reçues de la plaque:', data);

    // Mappage robuste gérant les clés françaises et anglaises
    const result = {
      marque: data.marque || data.make || data.Brand || '',
      modele: data.modele || data.model || data.Model || '',
      energie: data.energie || data.fuelType || data.Fuel || '',
      couleur: data.couleur || data.color || data.Color || '',
      annee: data.annee || data.year || data.Year || '',
      vin: data.vin || data.vinNumber || ''
    };

    // Nettoyer la casse pour afficher joliment
    if (result.marque) result.marque = result.marque.charAt(0).toUpperCase() + result.marque.slice(1).toLowerCase();
    if (result.modele) result.modele = result.modele.toUpperCase();
    if (result.energie) result.energie = result.energie.charAt(0).toUpperCase() + result.energie.slice(1).toLowerCase();
    if (result.couleur) result.couleur = result.couleur.charAt(0).toUpperCase() + result.couleur.slice(1).toLowerCase();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error("Erreur dans lookup-vehicle handler:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Erreur interne du serveur.' })
    };
  }
};
