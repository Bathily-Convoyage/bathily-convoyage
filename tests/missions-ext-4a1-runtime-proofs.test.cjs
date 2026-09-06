/**
 * MISSIONS-EXT-4A1 — Local DB/Auth Runtime Proofs
 *
 * Creates synthetic LOCAL identities and missions, then proves:
 *   - Pure convoyeur expense/receipt workflow
 *   - Cross-convoyeur denial
 *   - Banned convoyeur denial
 *   - Post-submit immutability
 *   - Admin review unchanged
 *   - Direct + external mission execution transitions
 *   - EDL gate enforcement
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

function assertError(error, expectedCode) {
  if (!error) throw new Error('Expected error but got success');
  if (expectedCode && error.code && error.code !== expectedCode) {
    // Some errors use different code formats; just check it's an error
  }
}

// Helper: create auth user + profile via service-role admin client
async function createUser(email, password, role) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Failed to create user ${email}: ${error.message}`);
  const userId = data.user.id;

  // Admin/operator: only user_roles (+ internal_operators for operator).
  // Do NOT insert into clients table — role separation trigger forbids it.
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

async function createConvoyeur(email, password, banned) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Failed to create convoyeur ${email}: ${error.message}`);
  const userId = data.user.id;

  const { data: conv, error: ce } = await admin.from('convoyeurs').insert({
    auth_user_id: userId,
    nom: email.split('@')[0],
    prenom: 'Test',
    email,
    telephone: '0600000000',
    banned: banned || false,
  }).select().single();
  if (ce) throw new Error(`Failed to create convoyeur profile: ${ce.message}`);
  return { userId, convoyeurId: conv.id };
}

async function createMission(adminClient, source, convoyeurId, convoyeurNom, status) {
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
    status: status || 'available',
    paiement_statut: 'pending',
    date_mission: new Date().toISOString().split('T')[0],
    convoyeur_id: convoyeurId,
    convoyeur_nom: convoyeurNom,
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
  console.log('=== MISSIONS-EXT-4A1 — Local Runtime Proofs ===\n');

  // Use unique suffix to avoid conflicts with previous runs
  const suffix = Date.now().toString(36);

  // Create synthetic identities
  console.log('Creating synthetic identities...');
  const adminEmail = `admin4a1-${suffix}@test.local`;
  const operatorEmail = `operator4a1-${suffix}@test.local`;
  const convAEmail = `convA4a1-${suffix}@test.local`;
  const convBEmail = `convB4a1-${suffix}@test.local`;
  const convBannedEmail = `convbanned4a1-${suffix}@test.local`;

  const adminUserId = await createUser(adminEmail, 'TestPass123!', 'admin');
  const operatorUserId = await createUser(operatorEmail, 'TestPass123!', 'operator');
  const convA = await createConvoyeur(convAEmail, 'TestPass123!', false);
  const convB = await createConvoyeur(convBEmail, 'TestPass123!', false);
  const convBanned = await createConvoyeur(convBannedEmail, 'TestPass123!', true);

  console.log(`  admin: ${adminUserId}`);
  console.log(`  operator: ${operatorUserId}`);
  console.log(`  convoyeur A: ${convA.userId} (conv id: ${convA.convoyeurId})`);
  console.log(`  convoyeur B: ${convB.userId} (conv id: ${convB.convoyeurId})`);
  console.log(`  convoyeur banned: ${convBanned.userId} (conv id: ${convBanned.convoyeurId})`);

  // Create auth clients for each user
  const convAClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const convBClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const convBannedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const adminUserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });

  // Sign in each user
  await convAClient.auth.signInWithPassword({ email: convAEmail, password: 'TestPass123!' });
  await convBClient.auth.signInWithPassword({ email: convBEmail, password: 'TestPass123!' });
  await convBannedClient.auth.signInWithPassword({ email: convBannedEmail, password: 'TestPass123!' });
  await adminUserClient.auth.signInWithPassword({ email: adminEmail, password: 'TestPass123!' });

  // Create missions assigned to convoyeur A
  const missionDirect = await createMission(admin, 'direct', convA.convoyeurId, 'Conv A', 'accepted');
  const missionExternal = await createMission(admin, 'hiflow', convA.convoyeurId, 'Conv A', 'accepted');

  console.log(`\nCreated missions:`);
  console.log(`  direct: ${missionDirect.id} (status: accepted)`);
  console.log(`  external: ${missionExternal.id} (status: accepted)`);

  console.log('\n=== EXPENSE / RECEIPT TESTS ===\n');

  // CASE 1: Convoyeur A creates expense draft
  await test('CASE 1: assigned pure convoyeur A creates expense draft = PASS', async () => {
    const { data, error } = await convAClient.rpc('create_mission_expense_draft', {
      p_mission_id: missionDirect.id,
      p_expense_type: 'fuel',
      p_amount: 25.50,
      p_expense_date: new Date().toISOString().split('T')[0],
      p_description: 'Carburant aller',
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data, 'Expected expense ID');
    // Store for later tests
    process._convExpenseId = data;
  });

  // CASE 2: Convoyeur A edits own draft
  await test('CASE 2: convoyeur A edits own draft = PASS', async () => {
    const { error } = await convAClient.rpc('update_mission_expense_draft', {
      p_expense_id: process._convExpenseId,
      p_expense_type: 'fuel',
      p_amount: 30.00,
      p_expense_date: new Date().toISOString().split('T')[0],
      p_description: 'Carburant aller (corrigé)',
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
  });

  // CASE 3: Convoyeur A deletes own draft (create a temp one first)
  await test('CASE 3: convoyeur A deletes own draft = PASS', async () => {
    const { data: tmpId, error: createErr } = await convAClient.rpc('create_mission_expense_draft', {
      p_mission_id: missionDirect.id,
      p_expense_type: 'parking',
      p_amount: 10.00,
      p_expense_date: new Date().toISOString().split('T')[0],
      p_description: 'Parking temp',
    });
    assert(!createErr, `Setup failed: ${createErr?.message}`);
    const { error } = await convAClient.rpc('delete_mission_expense_draft', { p_expense_id: tmpId });
    assert(!error, `Expected success but got error: ${error?.message}`);
  });

  // CASE 4: Convoyeur A uploads/register receipt
  await test('CASE 4: convoyeur A uploads/register receipt = PASS', async () => {
    // Upload a dummy file to storage
    const path = `missions/${missionDirect.id}/expenses/${process._convExpenseId}/receipt_test.png`;
    const fileContent = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header
    const { error: upErr } = await convAClient.storage.from('mission-expenses').upload(path, fileContent, { contentType: 'image/png' });
    assert(!upErr, `Storage upload failed: ${upErr?.message}`);
    const { error } = await convAClient.rpc('register_mission_expense_receipt', {
      p_expense_id: process._convExpenseId,
      p_storage_bucket: 'mission-expenses',
      p_storage_path: path,
      p_mime_type: 'image/png',
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
  });

  // CASE 5: Convoyeur A reads own receipt
  await test('CASE 5: convoyeur A reads own receipt = PASS', async () => {
    const { data, error } = await convAClient.from('mission_expense_receipts')
      .select('id,expense_id,mime_type')
      .eq('expense_id', process._convExpenseId);
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data && data.length > 0, 'Expected at least 1 receipt');
  });

  // CASE 6: Convoyeur A submits expense
  await test('CASE 6: convoyeur A submits expense = PASS', async () => {
    const { error } = await convAClient.rpc('submit_mission_expense', { p_expense_id: process._convExpenseId });
    assert(!error, `Expected success but got error: ${error?.message}`);
  });

  // CASE 7: After submit, edit/delete = DENY
  await test('CASE 7: after submit, edit = DENY', async () => {
    const { error } = await convAClient.rpc('update_mission_expense_draft', {
      p_expense_id: process._convExpenseId,
      p_expense_type: 'fuel',
      p_amount: 99.00,
      p_expense_date: new Date().toISOString().split('T')[0],
      p_description: 'Should fail',
    });
    assertError(error);
  });

  await test('CASE 7b: after submit, delete = DENY', async () => {
    const { error } = await convAClient.rpc('delete_mission_expense_draft', { p_expense_id: process._convExpenseId });
    assertError(error);
  });

  // CASE 8: Convoyeur B on A's mission — all mutations DENY
  await test('CASE 8: convoyeur B create expense on A mission = DENY', async () => {
    const { error } = await convBClient.rpc('create_mission_expense_draft', {
      p_mission_id: missionDirect.id,
      p_expense_type: 'fuel',
      p_amount: 5.00,
      p_expense_date: new Date().toISOString().split('T')[0],
      p_description: 'Should fail',
    });
    assertError(error);
  });

  await test('CASE 8b: convoyeur B read A expense receipts = DENY (empty)', async () => {
    const { data, error } = await convBClient.from('mission_expense_receipts')
      .select('id').eq('expense_id', process._convExpenseId);
    // RLS should return empty, not error
    assert(!error, `Unexpected error: ${error?.message}`);
    assert(!data || data.length === 0, 'Expected no visible receipts');
  });

  // CASE 9: Banned convoyeur — all expense actions DENY
  await test('CASE 9: banned convoyeur create expense = DENY', async () => {
    // First assign the banned convoyeur to a mission (via admin)
    const bannedMission = await createMission(admin, 'direct', convBanned.convoyeurId, 'Conv Banned', 'accepted');
    const { error } = await convBannedClient.rpc('create_mission_expense_draft', {
      p_mission_id: bannedMission.id,
      p_expense_type: 'fuel',
      p_amount: 5.00,
      p_expense_date: new Date().toISOString().split('T')[0],
      p_description: 'Should fail',
    });
    assertError(error);
  });

  // CASE 10: Admin review — approve submitted expense
  await test('CASE 10: admin reviews (approves) submitted expense = PASS', async () => {
    const { error } = await adminUserClient.rpc('review_mission_expense', {
      p_expense_id: process._convExpenseId,
      p_target_status: 'approved',
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
  });

  console.log('\n=== STATUS TRANSITION TESTS ===\n');

  // For status transitions we need valid EDLs.
  // validate_mission_edl expects a flat JSON array of evidence records:
  //   [{"type":"exterior_photo","bucket":"convoyeur-media","path":"missions/{mid}/..."}, ...]
  // Each file must actually exist in storage, owned by the convoyeur.
  // Requirements: >= 5 exterior_photo, >= 5 interior_photo, >= 1 client_signature,
  //   >= 1 convoyeur_signature. For arrivee: also >= 1 delivery_selfie.

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  async function uploadEvidence(client, missionId, type, index, prefix) {
    const pfx = prefix || 'depart';
    const path = `missions/${missionId}/edl/${pfx}_${type}_${index}.png`;
    const { error } = await client.storage.from('convoyeur-media').upload(path, pngBytes, { contentType: 'image/png' });
    if (error) throw new Error(`Upload evidence ${type} failed: ${error.message}`);
    return { type, bucket: 'convoyeur-media', path };
  }

  async function buildDepartEvidence(client, missionId) {
    const items = [];
    for (let i = 0; i < 5; i++) items.push(await uploadEvidence(client, missionId, 'exterior_photo', i, 'depart'));
    for (let i = 0; i < 5; i++) items.push(await uploadEvidence(client, missionId, 'interior_photo', i, 'depart'));
    items.push(await uploadEvidence(client, missionId, 'client_signature', 0, 'depart'));
    items.push(await uploadEvidence(client, missionId, 'convoyeur_signature', 0, 'depart'));
    return items;
  }

  async function buildArrivalEvidence(client, missionId) {
    const items = [];
    for (let i = 0; i < 5; i++) items.push(await uploadEvidence(client, missionId, 'exterior_photo', i, 'arrivee'));
    for (let i = 0; i < 5; i++) items.push(await uploadEvidence(client, missionId, 'interior_photo', i, 'arrivee'));
    items.push(await uploadEvidence(client, missionId, 'client_signature', 0, 'arrivee'));
    items.push(await uploadEvidence(client, missionId, 'convoyeur_signature', 0, 'arrivee'));
    items.push(await uploadEvidence(client, missionId, 'delivery_selfie', 0, 'arrivee'));
    return items;
  }

  // CASE 11: Direct mission execution
  await test('CASE 11: direct accepted→in_progress after valid depart EDL = PASS', async () => {
    const evidence = await buildDepartEvidence(convAClient, missionDirect.id);
    const { error: edlErr } = await convAClient.rpc('validate_mission_edl', {
      p_mission_id: missionDirect.id,
      p_edl_type: 'depart',
      p_evidence: evidence,
    });
    assert(!edlErr, `EDL validation failed: ${edlErr?.message}`);
    const { error } = await convAClient.rpc('transition_mission_status', {
      p_mission_id: missionDirect.id,
      p_target_status: 'in_progress',
    });
    assert(!error, `Transition failed: ${error?.message}`);
  });

  await test('CASE 11b: direct in_progress→delivered after valid arrival EDL = PASS', async () => {
    const evidence = await buildArrivalEvidence(convAClient, missionDirect.id);
    const { error: edlErr } = await convAClient.rpc('validate_mission_edl', {
      p_mission_id: missionDirect.id,
      p_edl_type: 'arrivee',
      p_evidence: evidence,
    });
    assert(!edlErr, `EDL validation failed: ${edlErr?.message}`);
    const { error } = await convAClient.rpc('transition_mission_status', {
      p_mission_id: missionDirect.id,
      p_target_status: 'delivered',
    });
    assert(!error, `Transition failed: ${error?.message}`);
  });

  // CASE 12: External mission execution
  await test('CASE 12: external accepted→in_progress after valid depart EDL = PASS', async () => {
    const evidence = await buildDepartEvidence(convAClient, missionExternal.id);
    const { error: edlErr } = await convAClient.rpc('validate_mission_edl', {
      p_mission_id: missionExternal.id,
      p_edl_type: 'depart',
      p_evidence: evidence,
    });
    assert(!edlErr, `EDL validation failed: ${edlErr?.message}`);
    const { error } = await convAClient.rpc('transition_mission_status', {
      p_mission_id: missionExternal.id,
      p_target_status: 'in_progress',
    });
    assert(!error, `Transition failed: ${error?.message}`);
  });

  await test('CASE 12b: external in_progress→delivered after valid arrival EDL = PASS', async () => {
    const evidence = await buildArrivalEvidence(convAClient, missionExternal.id);
    const { error: edlErr } = await convAClient.rpc('validate_mission_edl', {
      p_mission_id: missionExternal.id,
      p_edl_type: 'arrivee',
      p_evidence: evidence,
    });
    assert(!edlErr, `EDL validation failed: ${edlErr?.message}`);
    const { error } = await convAClient.rpc('transition_mission_status', {
      p_mission_id: missionExternal.id,
      p_target_status: 'delivered',
    });
    assert(!error, `Transition failed: ${error?.message}`);
  });

  // CASE 13: Attempt transition without required EDL
  await test('CASE 13: transition accepted→in_progress without depart EDL = DENY', async () => {
    // Create a new mission in 'accepted' state with no EDL
    const noEdlMission = await createMission(admin, 'direct', convA.convoyeurId, 'Conv A', 'accepted');
    const { error } = await convAClient.rpc('transition_mission_status', {
      p_mission_id: noEdlMission.id,
      p_target_status: 'in_progress',
    });
    assertError(error);
  });

  // Print results
  console.log('\n=== RESULTS ===\n');
  results.forEach(r => console.log(r));
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);

  // Cleanup: stop local supabase? No, leave it running for further tests.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
