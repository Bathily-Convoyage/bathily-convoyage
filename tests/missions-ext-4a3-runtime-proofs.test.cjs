/**
 * MISSIONS-EXT-4A3 — Local DB/Auth Runtime Proofs (External Billing Isolation)
 *
 * Proves:
 *   DIRECT:
 *     1. direct completed mission prepare_billing_record = PASS
 *     2. direct billing row created correctly = PASS
 *     3. direct existing Indy/billing flow unaffected = PASS
 *   EXTERNAL:
 *     4. hiflow prepare_billing_record = DENY
 *     5. driiveme prepare_billing_record = DENY
 *     6. alb prepare_billing_record = DENY
 *     7. other external source = DENY
 *   ATOMICITY:
 *     8. denied external call creates zero billing row
 *     9. denied external call creates zero invoice row
 *    10. denied external call creates zero billing/outbox side effect
 *    11. mission financial/lifecycle fields unchanged
 *   AUTH:
 *    12. existing unauthorized caller behavior remains DENY
 *    13. anon remains DENY
 *   BYPASS:
 *    14. direct table write remains RLS/ACL protected as before
 *   LEGACY:
 *    15. historical direct-compatible representation still works (source_mission='direct')
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

function assertError(error, msg) {
  if (!error) throw new Error(msg || 'Expected error but got success');
}

async function createUser(email, password, role) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(`Failed to create user ${email}: ${error.message}`);
  const userId = data.user.id;
  if (role === 'admin') {
    const { error: ure } = await admin.from('user_roles').insert({ user_id: userId, role: 'admin' });
    if (ure && ure.code !== '23505') throw new Error(`Failed to create admin user_roles: ${ure.message}`);
  } else if (role === 'operator') {
    const { error: ure } = await admin.from('user_roles').insert({ user_id: userId, role: 'operator' });
    if (ure) throw new Error(`Failed to create user_roles: ${ure.message}`);
    const { error: ioe } = await admin.from('internal_operators').insert({ user_id: userId, active: true, display_name: 'Test Operator' });
    if (ioe) throw new Error(`Failed to create internal_operators: ${ioe.message}`);
  }
  return userId;
}

async function createMission(adminClient, source, status) {
  const ref = 'TEST-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
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
    status: status || 'completed',
    paiement_statut: 'pending',
    date_mission: new Date().toISOString().split('T')[0],
    source_mission: source || 'direct',
  };
  if (source && source !== 'direct') {
    missionData.external_reference = 'EXT-' + ref;
  }
  const { data, error } = await adminClient.from('missions').insert(missionData).select().single();
  if (error) throw new Error(`Failed to create mission: ${error.message}`);
  return data;
}

async function main() {
  console.log('=== MISSIONS-EXT-4A3 — Local Runtime Proofs (External Billing Isolation) ===\n');

  const suffix = Date.now().toString(36);

  // Create admin
  const adminEmail = `admin4a3-${suffix}@test.local`;
  const operatorEmail = `operator4a3-${suffix}@test.local`;
  const adminUserId = await createUser(adminEmail, 'TestPass123!', 'admin');
  const operatorUserId = await createUser(operatorEmail, 'TestPass123!', 'operator');

  const adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const operatorClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });

  await adminClient.auth.signInWithPassword({ email: adminEmail, password: 'TestPass123!' });
  await operatorClient.auth.signInWithPassword({ email: operatorEmail, password: 'TestPass123!' });

  // Create missions
  const missionDirect = await createMission(admin, 'direct', 'completed');
  const missionHiflow = await createMission(admin, 'hiflow', 'completed');
  const missionDriiveme = await createMission(admin, 'driiveme', 'completed');
  const missionAlb = await createMission(admin, 'alb', 'completed');
  const missionOther = await createMission(admin, 'other', 'completed');

  console.log(`Created missions:`);
  console.log(`  direct: ${missionDirect.id} (source=${missionDirect.source_mission})`);
  console.log(`  hiflow: ${missionHiflow.id}`);
  console.log(`  driiveme: ${missionDriiveme.id}`);
  console.log(`  alb: ${missionAlb.id}`);
  console.log(`  other: ${missionOther.id}`);

  console.log('\n=== DIRECT TESTS ===\n');

  let directBillingId;
  await test('CASE 1: direct completed mission prepare_billing_record = PASS', async () => {
    const { data, error } = await adminClient.rpc('prepare_billing_record', {
      p_mission_id: missionDirect.id,
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data, 'Expected billing record ID');
    directBillingId = data;
  });

  await test('CASE 2: direct billing row created correctly = PASS', async () => {
    const { data, error } = await admin.from('billing_records')
      .select('id,mission_id,status,invoice_type,total_ht,provider')
      .eq('id', directBillingId).single();
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data.mission_id === missionDirect.id, 'mission_id matches');
    assert(data.status === 'prepared', 'status is prepared');
    assert(data.invoice_type === 'invoice', 'invoice_type is invoice');
    assert(parseFloat(data.total_ht) === 500, 'total_ht is 500');
    assert(data.provider === 'indy', 'provider is indy');
  });

  await test('CASE 3: direct existing Indy/billing flow unaffected = PASS', async () => {
    // Verify billing events were created
    const { data: events, error } = await admin.from('billing_events')
      .select('event_type')
      .eq('billing_record_id', directBillingId);
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(events && events.length > 0, 'Expected at least 1 billing event');
    assert(events.some(e => e.event_type === 'billing_record_created'), 'billing_record_created event exists');
  });

  console.log('\n=== EXTERNAL DENY TESTS ===\n');

  await test('CASE 4: hiflow prepare_billing_record = DENY', async () => {
    const { error } = await adminClient.rpc('prepare_billing_record', {
      p_mission_id: missionHiflow.id,
    });
    assertError(error, 'Expected denial for hiflow mission');
  });

  await test('CASE 5: driiveme prepare_billing_record = DENY', async () => {
    const { error } = await adminClient.rpc('prepare_billing_record', {
      p_mission_id: missionDriiveme.id,
    });
    assertError(error, 'Expected denial for driiveme mission');
  });

  await test('CASE 6: alb prepare_billing_record = DENY', async () => {
    const { error } = await adminClient.rpc('prepare_billing_record', {
      p_mission_id: missionAlb.id,
    });
    assertError(error, 'Expected denial for alb mission');
  });

  await test('CASE 7: other external source prepare_billing_record = DENY', async () => {
    const { error } = await adminClient.rpc('prepare_billing_record', {
      p_mission_id: missionOther.id,
    });
    assertError(error, 'Expected denial for other external mission');
  });

  console.log('\n=== ATOMICITY TESTS ===\n');

  await test('CASE 8: denied external call creates zero billing row', async () => {
    // Count billing records for all external missions
    const externalIds = [missionHiflow.id, missionDriiveme.id, missionAlb.id, missionOther.id];
    const { data, error } = await admin.from('billing_records')
      .select('id,mission_id')
      .in('mission_id', externalIds);
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(!data || data.length === 0, `Expected 0 billing records for external missions, got ${data?.length}`);
  });

  await test('CASE 9: denied external call creates zero invoice row', async () => {
    // billing_records with invoice_type='invoice' for external missions
    const externalIds = [missionHiflow.id, missionDriiveme.id, missionAlb.id, missionOther.id];
    const { data, error } = await admin.from('billing_records')
      .select('id')
      .in('mission_id', externalIds)
      .eq('invoice_type', 'invoice');
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(!data || data.length === 0, `Expected 0 invoice records for external missions, got ${data?.length}`);
  });

  await test('CASE 10: denied external call creates zero billing/outbox side effect', async () => {
    // Check no billing_events for external missions' (no billing records exist)
    const externalIds = [missionHiflow.id, missionDriiveme.id, missionAlb.id, missionOther.id];
    const { data: billingRecs } = await admin.from('billing_records')
      .select('id')
      .in('mission_id', externalIds);
    assert(!billingRecs || billingRecs.length === 0, 'No billing records exist for external missions');

    // Check no notification_outbox entries for external missions from billing
    const { data: outbox } = await admin.from('notification_outbox')
      .select('id')
      .in('mission_id', externalIds)
      .eq('notification_type', 'billing_record_created');
    assert(!outbox || outbox.length === 0, 'No billing outbox entries for external missions');
  });

  await test('CASE 11: mission financial/lifecycle fields unchanged after deny', async () => {
    // Verify external missions' status and montant_ht are unchanged
    const { data: hiflow } = await admin.from('missions')
      .select('status,montant_ht,source_mission')
      .eq('id', missionHiflow.id).single();
    assert(hiflow.status === 'completed', 'hiflow status still completed');
    assert(parseFloat(hiflow.montant_ht) === 500, 'hiflow montant_ht still 500');
    assert(hiflow.source_mission === 'hiflow', 'hiflow source_mission still hiflow');
  });

  console.log('\n=== AUTH TESTS ===\n');

  await test('CASE 12: existing unauthorized caller (operator) behavior remains DENY', async () => {
    const { error } = await operatorClient.rpc('prepare_billing_record', {
      p_mission_id: missionDirect.id,
    });
    assertError(error, 'Expected denial for operator (admin-only)');
  });

  await test('CASE 13: anon remains DENY', async () => {
    const { error } = await anonClient.rpc('prepare_billing_record', {
      p_mission_id: missionDirect.id,
    });
    assertError(error, 'Expected denial for anon');
  });

  console.log('\n=== BYPASS TESTS ===\n');

  await test('CASE 14: direct table write remains RLS/ACL protected', async () => {
    // An authenticated non-admin client should not be able to INSERT into billing_records directly
    const { error } = await operatorClient.from('billing_records').insert({
      mission_id: missionDirect.id,
      provider: 'indy',
      status: 'prepared',
      invoice_type: 'invoice',
      total_ht: 100,
      total_tva: 0,
      total_ttc: 100,
      currency: 'EUR',
    });
    assertError(error, 'Expected RLS to block direct INSERT into billing_records');
  });

  console.log('\n=== LEGACY TESTS ===\n');

  await test('CASE 15: historical direct-compatible representation still works (source_mission=direct)', async () => {
    // Create a second direct mission and verify it can be billed
    const missionDirect2 = await createMission(admin, 'direct', 'completed');
    const { data, error } = await adminClient.rpc('prepare_billing_record', {
      p_mission_id: missionDirect2.id,
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data, 'Expected billing record ID for second direct mission');
  });

  // Print results
  console.log('\n=== RESULTS ===\n');
  results.forEach(r => console.log(r));
  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
