/**
 * OPS-2A1B — Frontend Tariff RPC Switch Tests
 * Static tests verifying dashboard-admin.html uses the RPC, not direct update.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dashboardPath = path.join(__dirname, '..', 'dashboard-admin.html');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  \u2713 ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  \u2717 ${name}: ${err.message}`);
    });
}

async function main() {
  console.log('OPS-2A1B — Frontend Tariff RPC Switch Tests');
  console.log('');

  // A. dashboard-admin.html contains rpc('admin_update_mission_tariffs'
  await test('A: RPC call present in editMissionTariffs', () => {
    assert.ok(dashboard.includes("rpc('admin_update_mission_tariffs'"),
      'editMissionTariffs must call supabase.rpc("admin_update_mission_tariffs", ...)');
  });

  // B. No direct .from('missions').update for tariff mutation in editMissionTariffs
  await test('B: no direct .from(missions).update in editMissionTariffs', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    assert.ok(editFnMatch, 'editMissionTariffs function not found');
    const editFn = editFnMatch[0];
    assert.ok(!editFn.includes(".from('missions').update"),
      'editMissionTariffs must NOT contain .from("missions").update()');
    assert.ok(!editFn.includes('.from("missions").update'),
      'editMissionTariffs must NOT contain .from(\'missions\').update()');
  });

  // C. No frontend authoritative marge write from tariff editor
  await test('C: no marge write from tariff editor', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(!editFn.includes('marge'),
      'editMissionTariffs must NOT set marge — margin is derived server-side');
  });

  // D. Correct RPC parameters
  await test('D: correct RPC parameters', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(editFn.includes('p_mission_id'), 'must pass p_mission_id');
    assert.ok(editFn.includes('p_montant_ht'), 'must pass p_montant_ht');
    assert.ok(editFn.includes('p_remuneration_convoyeur'), 'must pass p_remuneration_convoyeur');
    assert.ok(editFn.includes('p_reason'), 'must pass p_reason');
  });

  // E. No fallback direct update
  await test('E: no fallback to direct update', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(!editFn.includes('.from('),
      'editMissionTariffs must NOT contain any .from() call — no fallback');
  });

  // F. Success refresh path exists
  await test('F: success refresh path (loadMissions)', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(editFn.includes('loadMissions()'),
      'editMissionTariffs must call loadMissions() on success');
  });

  // G. Error path exists
  await test('G: error path with user-friendly mapping', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(editFn.includes('if (error)'),
      'editMissionTariffs must handle RPC errors');
    assert.ok(editFn.includes('Swal.fire'),
      'editMissionTariffs must show error via Swal');
    // Check at least some error mapping exists
    assert.ok(editFn.includes('paiement'),
      'error mapping must cover payment guard');
    assert.ok(editFn.includes('session de paiement'),
      'error mapping must cover Stripe session guard');
    assert.ok(editFn.includes('facturation'),
      'error mapping must cover billing guard');
  });

  // H. Mission creation direct INSERT remains untouched
  await test('H: mission creation INSERT still present', () => {
    assert.ok(dashboard.includes(".from('missions').insert("),
      'mission creation INSERT must remain untouched');
  });

  // Additional: reason input exists
  await test('I: optional reason input present', () => {
    assert.ok(dashboard.includes('tariff-reason'),
      'tariff-reason input must be present in the modal');
    assert.ok(dashboard.includes('Raison de la modification'),
      'reason input placeholder must be present');
  });

  // Additional: client-side validation
  await test('J: client-side validation for price > 0', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(editFn.includes('parseFloat(price) <= 0'),
      'must validate price > 0 client-side');
  });

  await test('K: client-side validation for rem >= 0', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(editFn.includes('parseFloat(rem) < 0'),
      'must validate rem >= 0 client-side');
  });

  await test('L: client-side validation for rem <= price', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(editFn.includes('parseFloat(rem) > parseFloat(price)'),
      'must validate rem <= price client-side');
  });

  // Additional: NULL semantics (empty → null, not undefined)
  await test('M: NULL semantics for unchanged fields', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    assert.ok(editFn.includes('parseFloat(price) : null'),
      'empty price must map to null (not undefined)');
    assert.ok(editFn.includes('parseFloat(rem) : null'),
      'empty rem must map to null (not undefined)');
  });

  // Additional: no process.exit or global state interference
  await test('N: no Playwright interference', () => {
    assert.ok(!dashboard.includes('process.exit'),
      'dashboard-admin.html must not contain process.exit');
  });

  // O: Stripe session error mapping must be evaluated BEFORE generic payment mapping
  await test('O: Stripe session mapping before generic payment mapping', () => {
    const editFnMatch = dashboard.match(/window\.editMissionTariffs[\s\S]*?window\.deleteMission/);
    const editFn = editFnMatch[0];
    const sessionIdx = editFn.indexOf("session de paiement");
    const paiementIdx = editFn.indexOf("'paiement'");
    assert.ok(sessionIdx > -1, 'session de paiement mapping must exist');
    assert.ok(paiementIdx > -1, 'generic paiement mapping must exist');
    assert.ok(sessionIdx < paiementIdx,
      'session de paiement check must come BEFORE generic paiement check ' +
      '(otherwise generic swallows specific)');
  });

  console.log('\n=== SUMMARY ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('');
  if (failed > 0) {
    console.log('FAILED TESTS EXIST');
    throw new Error(`${failed} test(s) failed`);
  } else {
    console.log('ALL TESTS PASSED');
  }
}

// Only run when executed directly
if (!process.env.PW_WORKER_ID && !process.env.PLAYWRIGHT_WORKER_ID) {
  main().catch(err => {
    console.error('Fatal error:', err);
    throw err;
  });
} else {
  module.exports = {};
}
