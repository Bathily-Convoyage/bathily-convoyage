/**
 * MISSIONS-EXT-4B1 — Local DB Runtime Proofs for source-aware notifications.
 *
 * Verifies with a real local Supabase instance that:
 *   - DIRECT mission: mission_events trigger creates client + convoyeur outbox rows
 *   - EXTERNAL mission (hiflow/driiveme/alb/other): mission_events trigger creates
 *     convoyeur outbox rows ONLY (no client outbox row)
 *   - No direct-client outbox side effect for external missions
 *   - Direct mission outbox behavior unchanged
 *
 * LOCAL ONLY. Does not touch Production.
 * Requires local Supabase running (npx supabase start + npx supabase db reset).
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_SECRET_KEY) {
  console.error('SUPABASE_SECRET_KEY env var is required (run `npx supabase status` to get the local secret).');
  process.exit(3);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false } });

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { passed++; results.push(`  \u2713 ${name}`); })
    .catch((err) => { failed++; results.push(`  \u2717 ${name}: ${err.message}`); });
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function createConvoyeur(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'TestPass123!',
    email_confirm: true,
  });
  if (error) throw new Error(`Failed to create convoyeur auth user: ${error.message}`);
  const { data: conv, error: ce } = await admin.from('convoyeurs').insert({
    auth_user_id: data.user.id,
    nom: email.split('@')[0],
    prenom: 'Test',
    email,
    telephone: '0600000000',
    banned: false,
  }).select().single();
  if (ce) throw new Error(`Failed to create convoyeur profile: ${ce.message}`);
  return { userId: data.user.id, convoyeurId: conv.id, email };
}

async function createMission(source, convoyeurId, convoyeurNom, status) {
  const ref = 'B1-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const missionData = {
    reference: ref,
    depart: 'Paris',
    arrivee: 'Lyon',
    vehicule: 'Test Car',
    type_vehicule: 'Automobile',
    mode: 'route',
    pack: 'starter',
    montant_ht: 500,
    remuneration_convoyeur: 200,
    marge: 300,
    status: status || 'available',
    paiement_statut: 'pending',
    date_mission: new Date().toISOString().split('T')[0],
    convoyeur_id: convoyeurId,
    convoyeur_nom: convoyeurNom,
    source_mission: source,
  };
  if (source !== 'direct') {
    missionData.external_reference = 'EXT-' + ref;
  }
  const { data, error } = await admin.from('missions').insert(missionData).select().single();
  if (error) throw new Error(`Failed to create ${source} mission: ${error.message}`);
  return data;
}

async function insertMissionEvent(missionId, eventType) {
  const { data, error } = await admin.from('mission_events').insert({
    mission_id: missionId,
    event_type: eventType,
    metadata: { test: '4b1' },
  }).select().single();
  if (error) throw new Error(`Failed to insert mission_event ${eventType}: ${error.message}`);
  return data;
}

async function countOutboxRows(missionId, recipientType) {
  let query = admin.from('notification_outbox').select('id, recipient_type, notification_type, status', { count: 'exact' }).eq('mission_id', missionId);
  if (recipientType) {
    query = query.eq('recipient_type', recipientType);
  }
  const { count, error } = await query;
  if (error) throw new Error(`Failed to count outbox rows: ${error.message}`);
  return count || 0;
}

async function main() {
  console.log('=== MISSIONS-EXT-4B1 — Local Runtime Proofs ===\n');

  const suffix = Date.now().toString(36);
  const conv = await createConvoyeur(`conv4b1-${suffix}@test.local`);
  console.log(`  convoyeur: ${conv.userId} (conv id: ${conv.convoyeurId})`);

  // =====================================================
  // DIRECT mission — outbox behavior unchanged
  // =====================================================
  const directMission = await createMission('direct', conv.convoyeurId, 'TestConv', 'accepted');
  console.log(`  direct mission: ${directMission.id} (ref: ${directMission.reference})`);

  await test('DIRECT: mission_assigned event creates client outbox row', async () => {
    const evt = await insertMissionEvent(directMission.id, 'mission_assigned');
    // Wait a moment for trigger to fire (synchronous in Postgres, but Supabase REST returns after)
    const clientCount = await countOutboxRows(directMission.id, 'client');
    assert(clientCount >= 1, `expected >=1 client outbox row for direct mission, got ${clientCount}`);
  });

  await test('DIRECT: mission_assigned event creates convoyeur outbox row', async () => {
    const convCount = await countOutboxRows(directMission.id, 'convoyeur');
    assert(convCount >= 1, `expected >=1 convoyeur outbox row for direct mission, got ${convCount}`);
  });

  await test('DIRECT: mission_started event creates client outbox row', async () => {
    await insertMissionEvent(directMission.id, 'mission_started');
    const clientCount = await countOutboxRows(directMission.id, 'client');
    assert(clientCount >= 2, `expected >=2 client outbox rows for direct mission, got ${clientCount}`);
  });

  await test('DIRECT: mission_delivered event creates client outbox row', async () => {
    await insertMissionEvent(directMission.id, 'mission_delivered');
    const clientCount = await countOutboxRows(directMission.id, 'client');
    assert(clientCount >= 3, `expected >=3 client outbox rows for direct mission, got ${clientCount}`);
  });

  // =====================================================
  // HIFLOW external mission — no client outbox
  // =====================================================
  const hiflowMission = await createMission('hiflow', conv.convoyeurId, 'TestConv', 'accepted');
  console.log(`  hiflow mission: ${hiflowMission.id} (ref: ${hiflowMission.reference})`);

  await test('HIFLOW: mission_assigned event creates NO client outbox row', async () => {
    await insertMissionEvent(hiflowMission.id, 'mission_assigned');
    const clientCount = await countOutboxRows(hiflowMission.id, 'client');
    assert(clientCount === 0, `expected 0 client outbox rows for hiflow mission, got ${clientCount}`);
  });

  await test('HIFLOW: mission_assigned event creates convoyeur outbox row', async () => {
    const convCount = await countOutboxRows(hiflowMission.id, 'convoyeur');
    assert(convCount >= 1, `expected >=1 convoyeur outbox row for hiflow mission, got ${convCount}`);
  });

  await test('HIFLOW: mission_started event creates NO client outbox row', async () => {
    await insertMissionEvent(hiflowMission.id, 'mission_started');
    const clientCount = await countOutboxRows(hiflowMission.id, 'client');
    assert(clientCount === 0, `expected 0 client outbox rows for hiflow mission after mission_started, got ${clientCount}`);
  });

  await test('HIFLOW: mission_delivered event creates NO client outbox row', async () => {
    await insertMissionEvent(hiflowMission.id, 'mission_delivered');
    const clientCount = await countOutboxRows(hiflowMission.id, 'client');
    assert(clientCount === 0, `expected 0 client outbox rows for hiflow mission after mission_delivered, got ${clientCount}`);
  });

  await test('HIFLOW: total outbox rows are convoyeur-only', async () => {
    const totalCount = await countOutboxRows(hiflowMission.id);
    const convCount = await countOutboxRows(hiflowMission.id, 'convoyeur');
    assert(totalCount === convCount, `expected total (${totalCount}) to equal convoyeur count (${convCount}) — no client rows`);
  });

  // =====================================================
  // DRIIVEME external mission — no client outbox
  // =====================================================
  const driivemeMission = await createMission('driiveme', conv.convoyeurId, 'TestConv', 'accepted');
  console.log(`  driiveme mission: ${driivemeMission.id} (ref: ${driivemeMission.reference})`);

  await test('DRIIVEME: mission_assigned event creates NO client outbox row', async () => {
    await insertMissionEvent(driivemeMission.id, 'mission_assigned');
    const clientCount = await countOutboxRows(driivemeMission.id, 'client');
    assert(clientCount === 0, `expected 0 client outbox rows for driiveme mission, got ${clientCount}`);
  });

  await test('DRIIVEME: mission_assigned event creates convoyeur outbox row', async () => {
    const convCount = await countOutboxRows(driivemeMission.id, 'convoyeur');
    assert(convCount >= 1, `expected >=1 convoyeur outbox row for driiveme mission, got ${convCount}`);
  });

  // =====================================================
  // ALB external mission — no client outbox
  // =====================================================
  const albMission = await createMission('alb', conv.convoyeurId, 'TestConv', 'accepted');
  console.log(`  alb mission: ${albMission.id} (ref: ${albMission.reference})`);

  await test('ALB: mission_assigned event creates NO client outbox row', async () => {
    await insertMissionEvent(albMission.id, 'mission_assigned');
    const clientCount = await countOutboxRows(albMission.id, 'client');
    assert(clientCount === 0, `expected 0 client outbox rows for alb mission, got ${clientCount}`);
  });

  await test('ALB: mission_assigned event creates convoyeur outbox row', async () => {
    const convCount = await countOutboxRows(albMission.id, 'convoyeur');
    assert(convCount >= 1, `expected >=1 convoyeur outbox row for alb mission, got ${convCount}`);
  });

  // =====================================================
  // OTHER external mission — no client outbox
  // =====================================================
  const otherMission = await createMission('other', conv.convoyeurId, 'TestConv', 'accepted');
  console.log(`  other mission: ${otherMission.id} (ref: ${otherMission.reference})`);

  await test('OTHER: mission_assigned event creates NO client outbox row', async () => {
    await insertMissionEvent(otherMission.id, 'mission_assigned');
    const clientCount = await countOutboxRows(otherMission.id, 'client');
    assert(clientCount === 0, `expected 0 client outbox rows for other mission, got ${clientCount}`);
  });

  await test('OTHER: mission_assigned event creates convoyeur outbox row', async () => {
    const convCount = await countOutboxRows(otherMission.id, 'convoyeur');
    assert(convCount >= 1, `expected >=1 convoyeur outbox row for other mission, got ${convCount}`);
  });

  // =====================================================
  // ATOMICITY — external denial produces zero client side effects
  // =====================================================
  await test('ATOMICITY: external missions have zero client outbox rows across all events', async () => {
    // Fire remaining events on hiflow mission
    await insertMissionEvent(hiflowMission.id, 'edl_departure_validated');
    await insertMissionEvent(hiflowMission.id, 'edl_arrival_validated');
    await insertMissionEvent(hiflowMission.id, 'mission_cancelled');
    const clientCount = await countOutboxRows(hiflowMission.id, 'client');
    assert(clientCount === 0, `expected 0 client outbox rows after all events on hiflow, got ${clientCount}`);
  });

  await test('ATOMICITY: direct mission outbox preserved (not suppressed)', async () => {
    const clientCount = await countOutboxRows(directMission.id, 'client');
    assert(clientCount >= 3, `expected >=3 client outbox rows for direct mission, got ${clientCount}`);
  });

  // =====================================================
  // Cleanup
  // =====================================================
  const missionIds = [directMission.id, hiflowMission.id, driivemeMission.id, albMission.id, otherMission.id];
  for (const mid of missionIds) {
    await admin.from('notification_outbox').delete().eq('mission_id', mid);
    await admin.from('mission_events').delete().eq('mission_id', mid);
    await admin.from('missions').delete().eq('id', mid);
  }
  await admin.from('convoyeurs').delete().eq('id', conv.convoyeurId);
  await admin.auth.admin.deleteUser(conv.userId);

  // Print results
  console.log('\n=== Results ===');
  results.forEach(r => console.log(r));
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
