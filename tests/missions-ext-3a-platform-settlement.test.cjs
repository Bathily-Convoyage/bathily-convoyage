/**
 * MISSIONS-EXT-3A — Platform Settlement Semantics — Tests
 *
 * Covers:
 * - getMissionPaymentDisplay helper exists and is deterministic
 * - DIRECT: pending/paid keep existing direct wording
 * - HIFLOW/DRIIVEME/ALB/OTHER: pending => "En attente de règlement",
 *   paid => "Règlement reçu", action => "Marquer règlement reçu"
 * - External mission does not display "Payer" or Stripe wording
 * - External mission does not call create-checkout-session
 * - markMissionPaid uses source-aware confirmation/success wording
 * - No DB/RPC/RLS/Stripe changes
 *
 * Static tests only — no DB, no network, no browser.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
      console.log(`  \u2717 ${name}`);
      console.log(`    ERROR: ${err.message}`);
    });
}

// =====================================================
// File paths
// =====================================================
const DASH_PATH = path.join(__dirname, '..', 'dashboard-admin.html');
const CHECKOUT_PATH = path.join(__dirname, '..', 'functions', 'api', 'create-checkout-session.js');

// =====================================================
// Helpers — extract function body from dashboard
// =====================================================
function extractFunction(dash, fnName) {
  var start = dash.indexOf('function ' + fnName + '(');
  if (start < 0) start = dash.indexOf(fnName + ' = function');
  if (start < 0) start = dash.indexOf(fnName + ' = async function');
  if (start < 0) return '';
  var braceStart = dash.indexOf('{', start);
  var depth = 0;
  for (var i = braceStart; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) return dash.substring(start, i + 1); }
  }
  return dash.substring(start);
}

// =====================================================
// Setup — load dashboard and extract helper into VM
// =====================================================
const dash = fs.readFileSync(DASH_PATH, 'utf8');

// Extract getMissionPaymentDisplay
const helperBody = extractFunction(dash, 'getMissionPaymentDisplay');
assert.ok(helperBody, 'getMissionPaymentDisplay must exist in dashboard-admin.html');

// Create a minimal VM context to evaluate the helper
const sandbox = {};
// Evaluate as a function declaration, then expose it
vm.runInNewContext(helperBody + '\nthis.getMissionPaymentDisplay = getMissionPaymentDisplay;', sandbox);
const getMissionPaymentDisplay = sandbox.getMissionPaymentDisplay;
assert.ok(typeof getMissionPaymentDisplay === 'function', 'helper must be a function');

// =====================================================
// DIRECT MISSION TESTS
// =====================================================
async function runDirectTests() {
  console.log('\n--- DIRECT ---');

  await test('1. direct pending => "En attente" (unchanged)', () => {
    const d = getMissionPaymentDisplay({ source_mission: 'direct', paiement_statut: 'pending' });
    assert.strictEqual(d.badgeLabel, 'En attente');
    assert.strictEqual(d.pendingLabel, 'En attente');
    assert.strictEqual(d.isExternal, false);
    assert.strictEqual(d.isPaid, false);
  });

  await test('2. direct paid => "Payé" (unchanged)', () => {
    const d = getMissionPaymentDisplay({ source_mission: 'direct', paiement_statut: 'paid' });
    assert.strictEqual(d.badgeLabel, 'Payé');
    assert.strictEqual(d.paidLabel, 'Payé');
    assert.strictEqual(d.isExternal, false);
    assert.strictEqual(d.isPaid, true);
  });

  await test('3. direct action label => "Marquer payée" (unchanged)', () => {
    const d = getMissionPaymentDisplay({ source_mission: 'direct', paiement_statut: 'pending' });
    assert.strictEqual(d.actionLabel, 'Marquer payée');
  });

  await test('4. direct confirm title uses "payée" wording', () => {
    const d = getMissionPaymentDisplay({ source_mission: 'direct', paiement_statut: 'pending' });
    assert.ok(d.confirmTitle('BC-123').includes('payée'));
    assert.ok(!d.confirmTitle('BC-123').includes('règlement'));
  });

  await test('5. direct success message => "Payée !"', () => {
    const d = getMissionPaymentDisplay({ source_mission: 'direct', paiement_statut: 'pending' });
    assert.strictEqual(d.successMessage, 'Payée !');
  });

  await test('6. direct with legacy "paye" status treated as paid', () => {
    const d = getMissionPaymentDisplay({ source_mission: 'direct', paiement_statut: 'paye' });
    assert.strictEqual(d.isPaid, true);
    assert.strictEqual(d.badgeLabel, 'Payé');
  });

  await test('7. direct with null source defaults to direct', () => {
    const d = getMissionPaymentDisplay({ paiement_statut: 'pending' });
    assert.strictEqual(d.isExternal, false);
    assert.strictEqual(d.badgeLabel, 'En attente');
  });
}

// =====================================================
// EXTERNAL MISSION TESTS (HIFLOW, DRIIVEME, ALB, OTHER)
// =====================================================
async function runExternalTests() {
  const platforms = ['hiflow', 'driiveme', 'alb', 'other'];

  for (const platform of platforms) {
    console.log(`\n--- ${platform.toUpperCase()} ---`);

    await test(`${platform}: pending => "En attente de règlement"`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.strictEqual(d.isExternal, true);
      assert.strictEqual(d.badgeLabel, 'En attente de règlement');
      assert.strictEqual(d.pendingLabel, 'En attente de règlement');
      assert.strictEqual(d.isPaid, false);
    });

    await test(`${platform}: paid => "Règlement reçu"`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'paid' });
      assert.strictEqual(d.badgeLabel, 'Règlement reçu');
      assert.strictEqual(d.paidLabel, 'Règlement reçu');
      assert.strictEqual(d.isPaid, true);
    });

    await test(`${platform}: action label => "Marquer règlement reçu"`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.strictEqual(d.actionLabel, 'Marquer règlement reçu');
    });

    await test(`${platform}: section label => "Règlement plateforme"`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.strictEqual(d.sectionLabel, 'Règlement plateforme');
    });

    await test(`${platform}: confirm title uses "règlement" wording`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.ok(d.confirmTitle('HF-123').includes('règlement'));
      assert.ok(!d.confirmTitle('HF-123').includes('payée'));
    });

    await test(`${platform}: confirm button => "Oui, règlement reçu"`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.strictEqual(d.confirmButton, 'Oui, règlement reçu');
    });

    await test(`${platform}: success message => "Règlement reçu !"`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.strictEqual(d.successMessage, 'Règlement reçu !');
    });

    await test(`${platform}: does NOT use "Payé" or "En attente" alone`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.ok(d.badgeLabel !== 'En attente');
      assert.ok(d.badgeLabel !== 'Payé');
    });

    await test(`${platform}: does NOT use "Payer" wording`, () => {
      const d = getMissionPaymentDisplay({ source_mission: platform, paiement_statut: 'pending' });
      assert.ok(!d.actionLabel.includes('Payer'));
      assert.ok(!d.badgeLabel.includes('Payer'));
    });
  }
}

// =====================================================
// NO STRIPE / NO CHECKOUT FOR EXTERNAL
// =====================================================
async function runStripeIsolationTests() {
  console.log('\n--- STRIPE ISOLATION ---');

  const checkout = fs.readFileSync(CHECKOUT_PATH, 'utf8');

  // MISSIONS-EXT-3A.1 — Section label rendered in modal
  await test('section label rendered via payDisp.sectionLabel in details modal', () => {
    // Find the viewMissionDetails function and verify it renders payDisp.sectionLabel
    var fnStart = dash.indexOf('window.viewMissionDetails = async function');
    if (fnStart < 0) fnStart = dash.indexOf('viewMissionDetails = async function');
    assert.ok(fnStart > 0, 'viewMissionDetails must exist');
    var braceStart = dash.indexOf('{', fnStart);
    var depth = 0;
    var fnEnd = fnStart;
    for (var i = braceStart; i < dash.length; i++) {
      if (dash[i] === '{') depth++;
      else if (dash[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
    }
    var fnBody = dash.substring(fnStart, fnEnd + 1);
    assert.ok(fnBody.includes('payDisp.sectionLabel'),
      'viewMissionDetails must render payDisp.sectionLabel in the modal HTML');
  });

  await test('external mission blocked from Stripe checkout (guard exists)', () => {
    assert.ok(checkout.includes("mission.source_mission && mission.source_mission !== 'direct'"),
      'create-checkout-session must guard against non-direct missions');
  });

  await test('external mission does not call create-checkout-session in admin UI', () => {
    // The _doCreateExternalMission function must NOT call create-checkout-session
    var extFnStart = dash.indexOf('async function _doCreateExternalMission');
    assert.ok(extFnStart > 0, '_doCreateExternalMission must exist');
    var braceStart = dash.indexOf('{', extFnStart);
    var depth = 0;
    var extFnEnd = extFnStart;
    for (var i = braceStart; i < dash.length; i++) {
      if (dash[i] === '{') depth++;
      else if (dash[i] === '}') { depth--; if (depth === 0) { extFnEnd = i; break; } }
    }
    var extFn = dash.substring(extFnStart, extFnEnd + 1);
    assert.ok(!extFn.includes('create-checkout-session'),
      '_doCreateExternalMission must NOT call create-checkout-session');
    assert.ok(!extFn.includes('stripe.checkout'),
      '_doCreateExternalMission must NOT call stripe.checkout');
  });

  await test('markMissionPaid uses source-aware confirmation (not hardcoded "payée")', () => {
    var fnStart = dash.indexOf('window.markMissionPaid = async function');
    assert.ok(fnStart > 0, 'markMissionPaid must exist');
    var braceStart = dash.indexOf('{', fnStart);
    var depth = 0;
    var fnEnd = fnStart;
    for (var i = braceStart; i < dash.length; i++) {
      if (dash[i] === '{') depth++;
      else if (dash[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
    }
    var fnBody = dash.substring(fnStart, fnEnd + 1);
    assert.ok(fnBody.includes('getMissionPaymentDisplay'),
      'markMissionPaid must use getMissionPaymentDisplay for source-aware wording');
    assert.ok(fnBody.includes('payDisp.confirmTitle'),
      'markMissionPaid must use payDisp.confirmTitle');
    assert.ok(fnBody.includes('payDisp.successMessage'),
      'markMissionPaid must use payDisp.successMessage');
  });
}

// =====================================================
// NO DB / RPC / RLS / SCHEMA CHANGES
// =====================================================
async function runNoSchemaChangeTests() {
  console.log('\n--- NO DB CHANGES ---');

  await test('no new migration file for MISSIONS-EXT-3A', () => {
    // MISSIONS-EXT-3A is UI-only. No migration file belonging to 3A should
    // exist. This invariant is scoped to 3A-named migrations so it remains
    // independent of future unrelated migrations (e.g. MISSIONS-EXT-3B).
    const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
    const migrations3A = files.filter(f => /missions[-_]ext[-_]3a/i.test(f));
    assert.strictEqual(migrations3A.length, 0,
      'MISSIONS-EXT-3A must NOT add any migration (UI-only change). Found: ' + migrations3A.join(', '));
  });

  await test('mark_mission_paid RPC unchanged (no new migration touching it)', () => {
    // The RPC was created in 20260813000001 and last touched in 20260825075444 (grants).
    // No migration after the 3A baseline should modify it. This check is
    // content-scoped: it scans newer migrations but only asserts they don't
    // touch mark_mission_paid, so unrelated future migrations pass cleanly.
    const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
    const newMigrations = files.filter(f => {
      const ts = f.substring(0, 14);
      return ts > '20260906092229';
    });
    for (const f of newMigrations) {
      const content = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      assert.ok(!content.includes('mark_mission_paid'),
        `New migration ${f} must NOT touch mark_mission_paid RPC`);
    }
  });
}

// =====================================================
// RUN ALL
// =====================================================
(async () => {
  console.log('MISSIONS-EXT-3A — Platform Settlement Semantics\n');
  await runDirectTests();
  await runExternalTests();
  await runStripeIsolationTests();
  await runNoSchemaChangeTests();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
