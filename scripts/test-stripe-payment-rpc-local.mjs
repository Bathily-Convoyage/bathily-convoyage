// Local RPC tests for stripe payment RPCs
// Uses local Supabase on port 54322
// No Stripe network calls, no real secrets
import pg from 'pg';

const client = new pg.Client({
  host: 'localhost',
  port: 54322,
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  ssl: false
});

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`PASS: ${name}`);
    console.log(`PASS: ${name}`);
  } catch(e) {
    failed++;
    results.push(`FAIL: ${name} — ${e.message}`);
    console.log(`FAIL: ${name} — ${e.message}`);
  }
}

async function expectError(fn, errorContains) {
  try {
    await fn();
    throw new Error('Expected error but got success');
  } catch(e) {
    if (e.message === 'Expected error but got success') throw e;
    if (errorContains && !e.message.includes(errorContains)) {
      throw new Error(`Expected error containing "${errorContains}" but got: ${e.message}`);
    }
  }
}

async function run() {
  await client.connect();

  // TEST 1: Create mission with status=available, paiement_statut=pending, stripe_session_id=NULL
  await test('TEST 1: Create local mission', async () => {
    await client.query("DELETE FROM missions WHERE reference LIKE 'BC-RPC-TEST-%'");
    const r = await client.query(`
      INSERT INTO missions (reference, client_nom, depart, arrivee, vehicule, mode, pack, montant_ht, status, paiement_statut, stripe_session_id, date_mission)
      VALUES ('BC-RPC-TEST-001', 'RPC TEST', 'TEST A', 'TEST B', 'Test Car', 'route', 'Starter', 1.00, 'available', 'pending', NULL, '2026-08-20')
      RETURNING id
    `);
    if (!r.rows[0]) throw new Error('Insert failed');
    globalThis.missionId = r.rows[0].id;
  });

  // TEST 2: Direct UPDATE stripe_session_id with service_role => MUST FAIL (trigger blocks)
  await test('TEST 2: Direct UPDATE stripe_session_id blocked by trigger', async () => {
    await expectError(async () => {
      await client.query(`SET ROLE service_role`);
      try {
        await client.query(`UPDATE public.missions SET stripe_session_id = 'cs_test_bathily_rpc_001' WHERE id = $1`, [globalThis.missionId]);
      } finally {
        await client.query(`RESET ROLE`);
      }
    }, 'paiement');
  });

  // TEST 3: record_stripe_checkout_session with service_role => PASS
  await test('TEST 3: record_stripe_checkout_session links session', async () => {
    await client.query(`SET ROLE service_role`);
    try {
      const r = await client.query(`SELECT public.record_stripe_checkout_session($1, 'cs_test_bathily_rpc_001')`, [globalThis.missionId]);
      if (r.rows[0].record_stripe_checkout_session !== 'linked') {
        throw new Error(`Expected 'linked', got '${r.rows[0].record_stripe_checkout_session}'`);
      }
    } finally {
      await client.query(`RESET ROLE`);
    }
    // Verify
    const v = await client.query(`SELECT stripe_session_id FROM public.missions WHERE id = $1`, [globalThis.missionId]);
    if (v.rows[0].stripe_session_id !== 'cs_test_bathily_rpc_001') {
      throw new Error(`stripe_session_id not set correctly: ${v.rows[0].stripe_session_id}`);
    }
  });

  // TEST 4: Same RPC with same ID => idempotent / already_linked
  await test('TEST 4: record same session idempotent', async () => {
    await client.query(`SET ROLE service_role`);
    try {
      const r = await client.query(`SELECT public.record_stripe_checkout_session($1, 'cs_test_bathily_rpc_001')`, [globalThis.missionId]);
      if (r.rows[0].record_stripe_checkout_session !== 'already_linked') {
        throw new Error(`Expected 'already_linked', got '${r.rows[0].record_stripe_checkout_session}'`);
      }
    } finally {
      await client.query(`RESET ROLE`);
    }
  });

  // TEST 5: Same RPC with different session ID => MUST FAIL
  await test('TEST 5: record different session blocked', async () => {
    await expectError(async () => {
      await client.query(`SET ROLE service_role`);
      try {
        await client.query(`SELECT public.record_stripe_checkout_session($1, 'cs_test_bathily_rpc_002')`, [globalThis.missionId]);
      } finally {
        await client.query(`RESET ROLE`);
      }
    }, 'autre session');
    // Verify session 001 is preserved
    const v = await client.query(`SELECT stripe_session_id FROM public.missions WHERE id = $1`, [globalThis.missionId]);
    if (v.rows[0].stripe_session_id !== 'cs_test_bathily_rpc_001') {
      throw new Error(`Session 001 not preserved: ${v.rows[0].stripe_session_id}`);
    }
  });

  // TEST 6: RPC record with anon => REFUSED
  await test('TEST 6: record_stripe_checkout_session denied to anon', async () => {
    await expectError(async () => {
      await client.query(`SET ROLE anon`);
      try {
        await client.query(`SELECT public.record_stripe_checkout_session($1, 'cs_test_bathily_rpc_003')`, [globalThis.missionId]);
      } finally {
        await client.query(`RESET ROLE`);
      }
    }, 'permission');
  });

  // TEST 7: Verify SQL privileges
  await test('TEST 7: Execute privileges correct', async () => {
    const r = await client.query(`
      SELECT p.grantee, p.routine_name
      FROM information_schema.routine_privileges p
      WHERE p.routine_name IN ('record_stripe_checkout_session', 'complete_stripe_checkout_payment')
      AND p.routine_schema = 'public'
      ORDER BY p.routine_name, p.grantee
    `);
    const grants = {};
    for (const row of r.rows) {
      if (!grants[row.routine_name]) grants[row.routine_name] = [];
      grants[row.routine_name].push(row.grantee);
    }
    for (const fn of ['record_stripe_checkout_session', 'complete_stripe_checkout_payment']) {
      const grantees = grants[fn] || [];
      if (grantees.includes('PUBLIC')) throw new Error(`${fn}: PUBLIC has execute`);
      if (grantees.includes('anon')) throw new Error(`${fn}: anon has execute`);
      if (grantees.includes('authenticated')) throw new Error(`${fn}: authenticated has execute`);
      if (!grantees.includes('service_role')) throw new Error(`${fn}: service_role missing execute`);
    }
  });

  // TEST 8: Direct UPDATE paiement_statut with service_role => MUST FAIL
  await test('TEST 8: Direct UPDATE paiement_statut blocked by trigger', async () => {
    await expectError(async () => {
      await client.query(`SET ROLE service_role`);
      try {
        await client.query(`UPDATE public.missions SET paiement_statut = 'paid' WHERE id = $1`, [globalThis.missionId]);
      } finally {
        await client.query(`RESET ROLE`);
      }
    }, 'paiement');
  });

  // TEST 9: complete_stripe_checkout_payment with wrong session_id => MUST FAIL
  await test('TEST 9: complete payment with wrong session blocked', async () => {
    await expectError(async () => {
      await client.query(`SET ROLE service_role`);
      try {
        await client.query(`SELECT public.complete_stripe_checkout_payment($1, 'cs_test_bathily_rpc_002')`, [globalThis.missionId]);
      } finally {
        await client.query(`RESET ROLE`);
      }
    }, 'correspond');
    // Verify still pending
    const v = await client.query(`SELECT paiement_statut FROM public.missions WHERE id = $1`, [globalThis.missionId]);
    if (v.rows[0].paiement_statut !== 'pending') {
      throw new Error(`paiement_statut changed: ${v.rows[0].paiement_statut}`);
    }
  });

  // TEST 10: complete_stripe_checkout_payment with session 001 => PASS
  await test('TEST 10: complete payment with correct session', async () => {
    await client.query(`SET ROLE service_role`);
    try {
      const r = await client.query(`SELECT public.complete_stripe_checkout_payment($1, 'cs_test_bathily_rpc_001')`, [globalThis.missionId]);
      if (r.rows[0].complete_stripe_checkout_payment !== 'paid') {
        throw new Error(`Expected 'paid', got '${r.rows[0].complete_stripe_checkout_payment}'`);
      }
    } finally {
      await client.query(`RESET ROLE`);
    }
    const v = await client.query(`SELECT paiement_statut FROM public.missions WHERE id = $1`, [globalThis.missionId]);
    if (v.rows[0].paiement_statut !== 'paid') {
      throw new Error(`paiement_statut not paid: ${v.rows[0].paiement_statut}`);
    }
  });

  // TEST 11: Replay same RPC => idempotent / already_paid
  await test('TEST 11: replay payment idempotent', async () => {
    await client.query(`SET ROLE service_role`);
    try {
      const r = await client.query(`SELECT public.complete_stripe_checkout_payment($1, 'cs_test_bathily_rpc_001')`, [globalThis.missionId]);
      if (r.rows[0].complete_stripe_checkout_payment !== 'already_paid') {
        throw new Error(`Expected 'already_paid', got '${r.rows[0].complete_stripe_checkout_payment}'`);
      }
    } finally {
      await client.query(`RESET ROLE`);
    }
  });

  // TEST 12: Create second mission without stripe_session_id, then complete => MUST FAIL
  await test('TEST 12: complete payment on unlinked mission blocked', async () => {
    const r2 = await client.query(`
      INSERT INTO missions (reference, client_nom, depart, arrivee, vehicule, mode, pack, montant_ht, status, paiement_statut, stripe_session_id, date_mission)
      VALUES ('BC-RPC-TEST-002', 'RPC TEST 2', 'TEST C', 'TEST D', 'Test Car 2', 'route', 'Starter', 2.00, 'available', 'pending', NULL, '2026-08-20')
      RETURNING id
    `);
    const mission2Id = r2.rows[0].id;
    await expectError(async () => {
      await client.query(`SET ROLE service_role`);
      try {
        await client.query(`SELECT public.complete_stripe_checkout_payment($1, 'cs_test_bathily_rpc_001')`, [mission2Id]);
      } finally {
        await client.query(`RESET ROLE`);
      }
    }, 'Aucune session');
  });

  // TEST 13: Verify missions_sensitive_protect still exists and unchanged
  await test('TEST 13: missions_sensitive_protect exists and unchanged', async () => {
    const r = await client.query(`
      SELECT pg_get_functiondef(oid) as def
      FROM pg_proc
      WHERE proname = 'missions_sensitive_protect' AND pronamespace = 'public'::regnamespace
    `);
    if (r.rows.length === 0) throw new Error('missions_sensitive_protect not found');
    const def = r.rows[0].def;
    // SECURITY INVOKER is the default and may not appear in pg_get_functiondef output
    // Check prosecdef = false (not SECURITY DEFINER)
    const r2 = await client.query(`
      SELECT prosecdef FROM pg_proc
      WHERE proname = 'missions_sensitive_protect' AND pronamespace = 'public'::regnamespace
    `);
    if (r2.rows[0].prosecdef === true) throw new Error('Trigger is SECURITY DEFINER — should be INVOKER');
    if (!def.includes("search_path TO ''") && !def.includes("search_path = ''")) throw new Error('search_path not empty');
    if (!def.includes("current_user = 'postgres'")) throw new Error('postgres bypass missing');
    if (!def.includes('paiement_statut IS DISTINCT FROM OLD.paiement_statut')) throw new Error('paiement_statut protection missing');
    if (!def.includes('stripe_session_id IS DISTINCT FROM OLD.stripe_session_id')) throw new Error('stripe_session_id protection missing');
  });

  // Cleanup
  await client.query("DELETE FROM missions WHERE reference LIKE 'BC-RPC-TEST-%'");
  await client.end();

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => r.startsWith('FAIL'))) {
      console.log(`  ${r}`);
    }
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
