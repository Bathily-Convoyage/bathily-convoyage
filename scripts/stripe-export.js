import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

export async function exportStripeData() {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY is missing from environment variables.');
  }

  const stripe = new Stripe(stripeSecretKey);
  let supabase = null;

  if (supabaseUrl && supabaseServiceRoleKey) {
    supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  } else {
    console.warn('Supabase credentials missing. Will fallback to parsing Stripe descriptions.');
  }

  // Calculate timestamp for 7 days ago
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  console.log(`Fetching paid Stripe Checkout Sessions created since ${new Date(sevenDaysAgo * 1000).toISOString()}...`);

  const sessions = await stripe.checkout.sessions.list({
    created: { gte: sevenDaysAgo },
    limit: 100,
  });

  const transactions = [];
  let totalRevenue = 0;
  let totalChauffeurCost = 0;
  let totalEssenceCost = 0;
  let totalPeageCost = 0;
  let totalCosts = 0;
  let totalMargin = 0;

  for (const session of sessions.data) {
    if (session.payment_status !== 'paid') continue;

    const date = new Date(session.created * 1000).toISOString().split('T')[0];
    const amount = (session.amount_total || 0) / 100; // Stripe works in cents

    let route = 'Inconnu';
    let distanceKm = 0;
    let reference = session.metadata?.reference || 'N/A';
    let missionId = session.metadata?.mission_id;

    let missionFound = false;

    // Try to fetch mission from Supabase
    if (supabase && (missionId || reference !== 'N/A')) {
      try {
        let query = supabase.from('missions').select('depart_ville, arrivee_ville, distance_km, reference');
        if (missionId) {
          query = query.eq('id', missionId);
        } else {
          query = query.eq('reference', reference);
        }
        
        const { data: mission, error } = await query.single();
        if (mission && !error) {
          route = `${mission.depart_ville.trim()}-${mission.arrivee_ville.trim()}`;
          distanceKm = parseInt(mission.distance_km) || 0;
          reference = mission.reference;
          missionFound = true;
        }
      } catch (err) {
        console.warn(`Error querying Supabase for mission: ${err.message}`);
      }
    }

    // Fallback: Parse from description if Supabase lookup failed or wasn't configured
    if (!missionFound) {
      // Retrieve line items to get the description
      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
        const description = lineItems.data[0]?.description || '';
        
        // Expected format: "Convoyage Voiture : Paris ➔ Lyon · Réf: BC-2026-001"
        const routeMatch = description.match(/:\s*(.*?)\s*➔\s*(.*?)\s*·/);
        const refMatch = description.match(/Réf:\s*(\S+)/);

        if (routeMatch) {
          route = `${routeMatch[1].trim()}-${routeMatch[2].trim()}`;
        }
        if (refMatch) {
          reference = refMatch[1].trim();
        }

        // Estimate distance based on some standard routes if not found in DB
        // (Just a generic fallback helper, e.g. Paris-Lyon ~ 465km)
        const lowercaseRoute = route.toLowerCase();
        if (lowercaseRoute.includes('paris') && lowercaseRoute.includes('lyon')) distanceKm = 465;
        else if (lowercaseRoute.includes('marseille') && lowercaseRoute.includes('toulouse')) distanceKm = 404;
        else if (lowercaseRoute.includes('bordeaux')) distanceKm = 500;
        else distanceKm = 300; // default generic distance estimate
      } catch (err) {
        console.warn(`Error fetching line items for session ${session.id}: ${err.message}`);
      }
    }

    // Cost calculations
    // Chauffeur: 0.40€/km
    // Essence: 0.12€/km
    // Péage: 35€ flat rate
    const chauffeurCost = parseFloat((distanceKm * 0.40).toFixed(2));
    const essenceCost = parseFloat((distanceKm * 0.12).toFixed(2));
    const peageCost = distanceKm > 0 ? 35 : 0;
    const sessionTotalCost = parseFloat((chauffeurCost + essenceCost + peageCost).toFixed(2));
    const margin = parseFloat((amount - sessionTotalCost).toFixed(2));

    transactions.push({
      date,
      amount,
      reference,
      route,
      distance: `${distanceKm}km`,
      distance_value: distanceKm,
      costs: {
        chauffeur: chauffeurCost,
        essence: essenceCost,
        peage: peageCost,
        total: sessionTotalCost,
      },
      margin,
    });

    totalRevenue += amount;
    totalChauffeurCost += chauffeurCost;
    totalEssenceCost += essenceCost;
    totalPeageCost += peageCost;
    totalCosts += sessionTotalCost;
    totalMargin += margin;
  }

  // Sort transactions by date ascending
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  return {
    total_revenue: parseFloat(totalRevenue.toFixed(2)),
    total_costs: {
      chauffeur: parseFloat(totalChauffeurCost.toFixed(2)),
      essence: parseFloat(totalEssenceCost.toFixed(2)),
      peage: parseFloat(totalPeageCost.toFixed(2)),
      total: parseFloat(totalCosts.toFixed(2)),
    },
    net_margin: parseFloat(totalMargin.toFixed(2)),
    transactions,
  };
}
