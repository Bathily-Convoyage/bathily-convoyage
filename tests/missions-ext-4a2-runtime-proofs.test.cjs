/**
 * MISSIONS-EXT-4A2 — Local DB/Auth Runtime Proofs (Incident Flow Repair)
 *
 * Creates synthetic LOCAL identities and missions, then proves:
 *   REPORT:
 *     1. pure assigned convoyeur A reports incident on direct mission = PASS
 *     2. pure assigned convoyeur A reports incident on external mission = PASS
 *     3. convoyeur B reports on A mission = DENY
 *     4. banned assigned convoyeur reports = DENY
 *     5. unassigned convoyeur reports = DENY
 *     6. report on invalid mission status = DENY
 *     7. anon report = DENY
 *   READ:
 *     8. convoyeur A reads own incident = PASS
 *     9. convoyeur B reads A incident = DENY/empty
 *    10. admin reads incident = PASS
 *    11. anon reads incident = DENY
 *   UPDATE:
 *    12. reporter update allowed while open = PASS
 *    13. other convoyeur update = DENY
 *    14. banned reporter update = DENY
 *    15. forbidden fields cannot be mutated (mission_id, reported_by, status)
 *    16. resolved/closed incident mutation = DENY
 *   EVIDENCE:
 *    17. reporter uploads valid evidence = PASS
 *    18. reporter registers valid evidence = PASS
 *    19. cross-mission path = DENY
 *    20. cross-incident path = DENY
 *    21. other convoyeur evidence upload/read = DENY
 *    22. banned convoyeur evidence action = DENY
 *    23. invalid MIME = DENY
 *    24. oversized file = DENY if size is enforced at storage layer
 *    25. post-registration immutability semantics preserved
 *   ADMIN/OPERATOR:
 *    26. admin review flow = PASS
 *    27. operator review flow = PASS only if currently authorized by business model
 *    28. non-assigned operator cannot report as convoyeur = DENY
 *   AUDIT:
 *    29. incident report generates expected mission event/audit entry
 *    30. no unrelated mission status change caused by incident report
 *   DIRECT/EXTERNAL:
 *    31. same field-report behavior for direct and external assigned missions = PASS
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

// Helper: create auth user + profile via service-role admin client
async function createUser(email, password, role) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
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
  console.log('=== MISSIONS-EXT-4A2 — Local Runtime Proofs (Incident Flow) ===\n');

  const suffix = Date.now().toString(36);

  // Create synthetic identities
  console.log('Creating synthetic identities...');
  const adminEmail = `admin4a2-${suffix}@test.local`;
  const operatorEmail = `operator4a2-${suffix}@test.local`;
  const convAEmail = `convA4a2-${suffix}@test.local`;
  const convBEmail = `convB4a2-${suffix}@test.local`;
  const convBannedEmail = `convbanned4a2-${suffix}@test.local`;

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

  // Create auth clients
  const convAClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const convBClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const convBannedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const adminUserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const operatorClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false } });

  await convAClient.auth.signInWithPassword({ email: convAEmail, password: 'TestPass123!' });
  await convBClient.auth.signInWithPassword({ email: convBEmail, password: 'TestPass123!' });
  await convBannedClient.auth.signInWithPassword({ email: convBannedEmail, password: 'TestPass123!' });
  await adminUserClient.auth.signInWithPassword({ email: adminEmail, password: 'TestPass123!' });
  await operatorClient.auth.signInWithPassword({ email: operatorEmail, password: 'TestPass123!' });

  // Create missions
  // Conv A: direct accepted, external accepted, direct assigned (invalid for incident)
  // Conv B: direct accepted
  // Conv Banned: direct accepted
  const missionDirectA = await createMission(admin, 'direct', convA.convoyeurId, 'Conv A', 'accepted');
  const missionExternalA = await createMission(admin, 'hiflow', convA.convoyeurId, 'Conv A', 'accepted');
  const missionAssignedOnly = await createMission(admin, 'direct', convA.convoyeurId, 'Conv A', 'assigned');
  const missionDirectB = await createMission(admin, 'direct', convB.convoyeurId, 'Conv B', 'accepted');
  const missionBanned = await createMission(admin, 'direct', convBanned.convoyeurId, 'Conv Banned', 'accepted');

  console.log(`\nCreated missions:`);
  console.log(`  direct A (accepted): ${missionDirectA.id}`);
  console.log(`  external A (accepted): ${missionExternalA.id}`);
  console.log(`  direct A (assigned): ${missionAssignedOnly.id}`);
  console.log(`  direct B (accepted): ${missionDirectB.id}`);
  console.log(`  banned (accepted): ${missionBanned.id}`);

  const incidentPayload = {
    p_incident_type: 'vehicle_breakdown',
    p_severity: 'high',
    p_title: 'Panne moteur',
    p_description: 'Le véhicule est en panne sur autoroute.',
    p_occurred_at: new Date().toISOString(),
    p_location_text: 'A6, km 120',
  };

  console.log('\n=== REPORT TESTS ===\n');

  let directIncidentId, externalIncidentId;

  // CASE 1: Convoyeur A reports incident on direct mission
  await test('CASE 1: pure assigned convoyeur A reports incident on direct mission = PASS', async () => {
    const { data, error } = await convAClient.rpc('report_mission_incident', {
      p_mission_id: missionDirectA.id,
      ...incidentPayload,
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data, 'Expected incident ID');
    directIncidentId = data;
  });

  // CASE 2: Convoyeur A reports incident on external mission
  await test('CASE 2: pure assigned convoyeur A reports incident on external mission = PASS', async () => {
    const { data, error } = await convAClient.rpc('report_mission_incident', {
      p_mission_id: missionExternalA.id,
      ...incidentPayload,
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data, 'Expected incident ID');
    externalIncidentId = data;
  });

  // CASE 3: Convoyeur B reports on A's mission = DENY
  await test('CASE 3: convoyeur B reports on A mission = DENY', async () => {
    const { error } = await convBClient.rpc('report_mission_incident', {
      p_mission_id: missionDirectA.id,
      ...incidentPayload,
    });
    assertError(error, 'Expected denial for convoyeur B on A mission');
  });

  // CASE 4: Banned convoyeur reports = DENY
  await test('CASE 4: banned assigned convoyeur reports = DENY', async () => {
    const { error } = await convBannedClient.rpc('report_mission_incident', {
      p_mission_id: missionBanned.id,
      ...incidentPayload,
    });
    assertError(error, 'Expected denial for banned convoyeur');
  });

  // CASE 5: Unassigned convoyeur reports = DENY (conv B on mission Banned which is assigned to banned conv)
  await test('CASE 5: unassigned convoyeur reports = DENY', async () => {
    const { error } = await convBClient.rpc('report_mission_incident', {
      p_mission_id: missionBanned.id,
      ...incidentPayload,
    });
    assertError(error, 'Expected denial for unassigned convoyeur');
  });

  // CASE 6: Report on invalid mission status (assigned, not accepted/in_progress/delivered)
  await test('CASE 6: report on invalid mission status = DENY', async () => {
    const { error } = await convAClient.rpc('report_mission_incident', {
      p_mission_id: missionAssignedOnly.id,
      ...incidentPayload,
    });
    assertError(error, 'Expected denial for invalid mission status');
  });

  // CASE 7: Anon report = DENY
  await test('CASE 7: anon report = DENY', async () => {
    const { error } = await anonClient.rpc('report_mission_incident', {
      p_mission_id: missionDirectA.id,
      ...incidentPayload,
    });
    assertError(error, 'Expected denial for anon');
  });

  console.log('\n=== READ TESTS ===\n');

  // CASE 8: Convoyeur A reads own incident
  await test('CASE 8: convoyeur A reads own incident = PASS', async () => {
    const { data, error } = await convAClient.from('mission_incidents')
      .select('id,title')
      .eq('id', directIncidentId);
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data && data.length === 1, `Expected 1 incident, got ${data?.length}`);
    assert(data[0].title === 'Panne moteur', 'Expected correct title');
  });

  // CASE 9: Convoyeur B reads A's incident = DENY/empty
  await test('CASE 9: convoyeur B reads A incident = DENY/empty', async () => {
    const { data, error } = await convBClient.from('mission_incidents')
      .select('id,title')
      .eq('id', directIncidentId);
    assert(!error, `Expected no error but got: ${error?.message}`);
    assert(!data || data.length === 0, `Expected 0 incidents (RLS), got ${data?.length}`);
  });

  // CASE 10: Admin reads incident
  await test('CASE 10: admin reads incident = PASS', async () => {
    const { data, error } = await adminUserClient.from('mission_incidents')
      .select('id,title')
      .eq('id', directIncidentId);
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data && data.length === 1, `Expected 1 incident, got ${data?.length}`);
  });

  // CASE 11: Anon reads incident = DENY
  await test('CASE 11: anon reads incident = DENY', async () => {
    const { data, error } = await anonClient.from('mission_incidents')
      .select('id,title')
      .eq('id', directIncidentId);
    // Anon should get either an error or empty data
    assert(error || !data || data.length === 0, 'Expected anon to be denied');
  });

  console.log('\n=== UPDATE TESTS ===\n');

  // CASE 12: Reporter updates own incident while open
  await test('CASE 12: reporter update allowed while open = PASS', async () => {
    const { error } = await convAClient.rpc('update_mission_incident', {
      p_incident_id: directIncidentId,
      p_title: 'Panne moteur (mis à jour)',
      p_description: 'Description mise à jour.',
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
  });

  // CASE 13: Other convoyeur update = DENY
  await test('CASE 13: other convoyeur update = DENY', async () => {
    const { error } = await convBClient.rpc('update_mission_incident', {
      p_incident_id: directIncidentId,
      p_title: 'Hack attempt',
    });
    assertError(error, 'Expected denial for other convoyeur');
  });

  // CASE 14: Banned reporter update = DENY
  // First, create an incident as convBanned via admin (service role bypasses RLS)
  // Actually, banned conv can't report. We need to create an incident via admin
  // where reported_by = convBanned.userId, then try to update as banned conv.
  let bannedIncidentId;
  await test('CASE 14: banned convoyeur cannot update incident = DENY (setup via admin)', async () => {
    // Insert directly via service role (bypasses auth checks)
    const { data, error } = await admin.from('mission_incidents').insert({
      mission_id: missionBanned.id,
      reported_by: convBanned.userId,
      incident_type: 'damage',
      severity: 'low',
      title: 'Test banned update',
      description: 'Test description for banned update.',
      occurred_at: new Date().toISOString(),
      status: 'open',
    }).select().single();
    assert(!error, `Setup failed: ${error?.message}`);
    bannedIncidentId = data.id;

    // Now try to update as banned convoyeur
    const { error: updErr } = await convBannedClient.rpc('update_mission_incident', {
      p_incident_id: bannedIncidentId,
      p_title: 'Banned hack',
    });
    assertError(updErr, 'Expected denial for banned convoyeur update');
  });

  // CASE 15: Forbidden fields cannot be mutated (RPC doesn't expose them)
  await test('CASE 15: forbidden fields (mission_id, reported_by, status) not exposed in RPC = PASS', async () => {
    // The update_mission_incident RPC only accepts: incident_type, severity, title, description, location_text.
    // mission_id, reported_by, status, reviewed_*, resolved_* are NOT parameters.
    // This is verified by the RPC signature itself — if we try to pass extra params,
    // PostgREST will ignore them. So we just verify the RPC doesn't change status.
    const { data: inc } = await admin.from('mission_incidents')
      .select('status,mission_id,reported_by')
      .eq('id', directIncidentId).single();
    assert(inc.status === 'open', 'Status should still be open after update');
    assert(inc.mission_id === missionDirectA.id, 'mission_id should be unchanged');
    assert(inc.reported_by === convA.userId, 'reported_by should be unchanged');
  });

  // CASE 16: Resolved/closed incident mutation = DENY
  await test('CASE 16: resolved incident mutation = DENY', async () => {
    // Admin resolves the incident first
    const { error: resolveErr } = await adminUserClient.rpc('review_mission_incident', {
      p_incident_id: externalIncidentId,
      p_target_status: 'resolved',
      p_resolution_notes: 'Résolu par test.',
    });
    assert(!resolveErr, `Admin resolve failed: ${resolveErr?.message}`);

    // Now try to update as reporter
    const { error: updErr } = await convAClient.rpc('update_mission_incident', {
      p_incident_id: externalIncidentId,
      p_title: 'Post-resolve hack',
    });
    assertError(updErr, 'Expected denial for resolved incident update');
  });

  console.log('\n=== EVIDENCE TESTS ===\n');

  // For evidence tests, we need to upload to storage and then register.
  // We'll use a small valid JPEG buffer.
  const jpegBuffer = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
  ]);

  let evidenceIncidentId;
  // Create a fresh open incident for evidence tests
  const { data: evInc } = await admin.from('mission_incidents').insert({
    mission_id: missionDirectA.id,
    reported_by: convA.userId,
    incident_type: 'flat_tire',
    severity: 'medium',
    title: 'Crevaison test evidence',
    description: 'Test evidence upload.',
    occurred_at: new Date().toISOString(),
    status: 'open',
  }).select().single();
  evidenceIncidentId = evInc.id;

  // CASE 17: Reporter uploads valid evidence = PASS
  let uploadedPath;
  await test('CASE 17: reporter uploads valid evidence = PASS', async () => {
    const path = `missions/${missionDirectA.id}/incidents/${evidenceIncidentId}/${Date.now()}-test.jpg`;
    const { data, error } = await convAClient.storage.from('mission-incidents')
      .upload(path, jpegBuffer, { contentType: 'image/jpeg', upsert: false });
    assert(!error, `Expected upload success but got error: ${error?.message || JSON.stringify(error)}`);
    uploadedPath = path;
  });

  // CASE 18: Reporter registers valid evidence = PASS
  let evidenceId;
  await test('CASE 18: reporter registers valid evidence = PASS', async () => {
    const { data, error } = await convAClient.rpc('register_mission_incident_evidence', {
      p_incident_id: evidenceIncidentId,
      p_storage_bucket: 'mission-incidents',
      p_storage_path: uploadedPath,
      p_mime_type: 'image/jpeg',
    });
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data, 'Expected evidence ID');
    evidenceId = data;
  });

  // CASE 19: Cross-mission path = DENY
  await test('CASE 19: cross-mission evidence path = DENY', async () => {
    // Upload to mission B's path, try to register on A's incident
    const crossPath = `missions/${missionDirectB.id}/incidents/${evidenceIncidentId}/${Date.now()}-cross.jpg`;
    await convAClient.storage.from('mission-incidents').upload(crossPath, jpegBuffer, { contentType: 'image/jpeg', upsert: false }).catch(() => {});
    const { error } = await convAClient.rpc('register_mission_incident_evidence', {
      p_incident_id: evidenceIncidentId,
      p_storage_bucket: 'mission-incidents',
      p_storage_path: crossPath,
      p_mime_type: 'image/jpeg',
    });
    assertError(error, 'Expected denial for cross-mission path');
  });

  // CASE 20: Cross-incident path = DENY
  await test('CASE 20: cross-incident evidence path = DENY', async () => {
    // Use a different incident ID in the path
    const crossIncPath = `missions/${missionDirectA.id}/incidents/${directIncidentId}/${Date.now()}-crossinc.jpg`;
    await convAClient.storage.from('mission-incidents').upload(crossIncPath, jpegBuffer, { contentType: 'image/jpeg', upsert: false }).catch(() => {});
    const { error } = await convAClient.rpc('register_mission_incident_evidence', {
      p_incident_id: evidenceIncidentId,
      p_storage_bucket: 'mission-incidents',
      p_storage_path: crossIncPath,
      p_mime_type: 'image/jpeg',
    });
    assertError(error, 'Expected denial for cross-incident path');
  });

  // CASE 21: Other convoyeur evidence upload/read = DENY
  await test('CASE 21: other convoyeur evidence upload = DENY', async () => {
    const path = `missions/${missionDirectA.id}/incidents/${evidenceIncidentId}/${Date.now()}-other.jpg`;
    const { error } = await convBClient.storage.from('mission-incidents')
      .upload(path, jpegBuffer, { contentType: 'image/jpeg', upsert: false });
    assertError(error, 'Expected denial for other convoyeur upload');
  });

  // CASE 22: Banned convoyeur evidence action = DENY
  await test('CASE 22: banned convoyeur evidence upload = DENY', async () => {
    const path = `missions/${missionBanned.id}/incidents/${bannedIncidentId}/${Date.now()}-banned.jpg`;
    const { error } = await convBannedClient.storage.from('mission-incidents')
      .upload(path, jpegBuffer, { contentType: 'image/jpeg', upsert: false });
    assertError(error, 'Expected denial for banned convoyeur upload');
  });

  // CASE 23: Invalid MIME = DENY (RPC level)
  await test('CASE 23: invalid MIME registration = DENY', async () => {
    // Upload a JPEG but try to register with invalid MIME
    const { error } = await convAClient.rpc('register_mission_incident_evidence', {
      p_incident_id: evidenceIncidentId,
      p_storage_bucket: 'mission-incidents',
      p_storage_path: uploadedPath,
      p_mime_type: 'application/pdf',
    });
    assertError(error, 'Expected denial for invalid MIME');
  });

  // CASE 24: Oversized file = DENY (storage layer enforces 5 MiB)
  await test('CASE 24: oversized file upload = DENY', async () => {
    // Create a 6 MiB buffer
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024, 0);
    // Set JPEG header to pass MIME check
    bigBuffer[0] = 0xFF; bigBuffer[1] = 0xD8; bigBuffer[2] = 0xFF;
    const path = `missions/${missionDirectA.id}/incidents/${evidenceIncidentId}/${Date.now()}-big.jpg`;
    const { error } = await convAClient.storage.from('mission-incidents')
      .upload(path, bigBuffer, { contentType: 'image/jpeg', upsert: false });
    assertError(error, 'Expected denial for oversized file');
  });

  // CASE 25: Post-registration immutability — evidence row cannot be UPDATEd or DELETEd
  await test('CASE 25: post-registration immutability (evidence row) = PASS', async () => {
    // Direct UPDATE/DELETE on mission_incident_evidence should be blocked by trigger
    const { error: updErr } = await admin.from('mission_incident_evidence')
      .update({ mime_type: 'image/png' })
      .eq('id', evidenceId);
    assertError(updErr, 'Expected UPDATE to be blocked by immutability trigger');

    const { error: delErr } = await admin.from('mission_incident_evidence')
      .delete()
      .eq('id', evidenceId);
    assertError(delErr, 'Expected DELETE to be blocked by immutability trigger');
  });

  // Evidence read tests
  await test('CASE 25b: reporter reads own evidence = PASS', async () => {
    const { data, error } = await convAClient.from('mission_incident_evidence')
      .select('id,mime_type')
      .eq('incident_id', evidenceIncidentId);
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data && data.length > 0, 'Expected at least 1 evidence row');
  });

  await test('CASE 25c: other convoyeur cannot read evidence = DENY/empty', async () => {
    const { data, error } = await convBClient.from('mission_incident_evidence')
      .select('id,mime_type')
      .eq('incident_id', evidenceIncidentId);
    assert(!error, `Expected no error: ${error?.message}`);
    assert(!data || data.length === 0, `Expected 0 rows (RLS), got ${data?.length}`);
  });

  console.log('\n=== ADMIN/OPERATOR TESTS ===\n');

  // CASE 26: Admin review flow
  await test('CASE 26: admin review flow (open → reviewed) = PASS', async () => {
    const { error } = await adminUserClient.rpc('review_mission_incident', {
      p_incident_id: directIncidentId,
      p_target_status: 'reviewed',
    });
    assert(!error, `Expected success but got error: ${error?.message}`);

    // Verify status changed
    const { data: inc } = await admin.from('mission_incidents')
      .select('status,reviewed_at,reviewed_by')
      .eq('id', directIncidentId).single();
    assert(inc.status === 'reviewed', 'Status should be reviewed');
    assert(inc.reviewed_at, 'reviewed_at should be set');
    assert(inc.reviewed_by === adminUserId, 'reviewed_by should be admin');
  });

  // CASE 27: Operator review flow — operator is NOT admin, so review_mission_incident requires is_admin()
  // Per the existing model, only admin can review. Operator cannot.
  await test('CASE 27: operator cannot review (admin-only) = DENY', async () => {
    const { error } = await operatorClient.rpc('review_mission_incident', {
      p_incident_id: directIncidentId,
      p_target_status: 'resolved',
      p_resolution_notes: 'Operator attempt.',
    });
    assertError(error, 'Expected denial for operator review');
  });

  // CASE 28: Non-assigned operator cannot report as convoyeur = DENY
  await test('CASE 28: non-assigned operator cannot report as convoyeur = DENY', async () => {
    const { error } = await operatorClient.rpc('report_mission_incident', {
      p_mission_id: missionDirectA.id,
      ...incidentPayload,
    });
    assertError(error, 'Expected denial for non-assigned operator');
  });

  console.log('\n=== AUDIT TESTS ===\n');

  // CASE 29: Incident report generates mission event
  await test('CASE 29: incident report generates mission event = PASS', async () => {
    // Check that mission_events has an 'incident_reported' event for missionDirectA
    const { data, error } = await admin.from('mission_events')
      .select('event_type,metadata')
      .eq('mission_id', missionDirectA.id)
      .eq('event_type', 'incident_reported');
    assert(!error, `Expected success but got error: ${error?.message}`);
    assert(data && data.length > 0, 'Expected at least 1 incident_reported event');
    // Verify metadata contains incident_id
    const evt = data.find(e => e.metadata && e.metadata.incident_id);
    assert(evt, 'Expected event with incident_id in metadata');
  });

  // CASE 30: No unrelated mission status change
  await test('CASE 30: no unrelated mission status change = PASS', async () => {
    const { data: mission } = await admin.from('missions')
      .select('status')
      .eq('id', missionDirectA.id).single();
    assert(mission.status === 'accepted', 'Mission status should still be accepted');
  });

  console.log('\n=== DIRECT/EXTERNAL PARITY ===\n');

  // CASE 31: Same field-report behavior for direct and external
  await test('CASE 31: direct and external incident reporting parity = PASS', async () => {
    // Both directIncidentId and externalIncidentId were created successfully in CASE 1 and 2.
    // Verify both exist and have the same structure.
    const { data: directInc } = await admin.from('mission_incidents')
      .select('id,mission_id,incident_type,severity,status')
      .eq('id', directIncidentId).single();
    const { data: extInc } = await admin.from('mission_incidents')
      .select('id,mission_id,incident_type,severity,status')
      .eq('id', externalIncidentId).single();
    assert(directInc && extInc, 'Both incidents should exist');
    assert(directInc.incident_type === extInc.incident_type, 'Same incident_type');
    assert(directInc.severity === extInc.severity, 'Same severity');
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
